// Second Reality — GLENZ part (Future Crew, 1993) — browser port
// Faithful port of GLENZ/MAIN.C + VEC.ASM + NEW.ASM + MATH.ASM to JS/Three.js.
// Original source is public domain (Unlicense, 2013 anniversary release).
//
// Architecture notes (matching the original):
//  - virtual VGA: 320x200 (mode 13h) indexed framebuffer + 256-entry 6-bit DAC
//  - intro runs in the previous part's 320x400 mode (BEGLOGO title + zoomer2 wipe)
//  - renderer = XOR span-transition engine with frame-delta updates ("NEW copper")
//  - music = MUSIC1.S3M via libopenmpt (chiptune3 AudioWorklet), starts with the part
//  - timeline = virtual 70 Hz vblank clock anchored to the audio clock

import * as THREE from './vendor/three.module.min.js';

// ---------------------------------------------------------------------------
// Tunables / sync constants
// ---------------------------------------------------------------------------
// dis_setmframe(0) happens when dis_musplus() first returns >= -19.
// STMIK's "plus" events are the +++ (254) markers in the demo's S3M order
// list; musplus counts rows relative to the next/previous marker. The first
// +++ sits after the third order (patterns 73, 39, 50), so the gate opens at
// row 45 of order 2 = 6.5187 s into MUSIC1 (computed with libopenmpt).
const MFRAME0_S = 6.5187;       // music time when mframe==0 (wipe starts)
const VBLANK_HZ = 70;           // mode 13h vertical refresh
// The part exits when musplus re-enters (-16,0), i.e. 15 rows before the
// second +++ marker: 43.669 s => frame (43.669-6.5187)*70 - 333 ~= 2267.
const END_FRAME = 2267;         // main-loop frame at which the part is over
const DEBUG = new URLSearchParams(location.search);

// ---------------------------------------------------------------------------
// Data from MAIN.C
// ---------------------------------------------------------------------------
const ZZZ = 50, QQQ = 99;
function pts(arr, m) { const o = [arr.length / 3]; for (const v of arr) o.push(v * m); return o; }

// 14-point "glenz" solid: cube + 6 spike vertices (long array layout: [count, x,y,z, ...])
const pointsBase = pts([
  -100,-100,-100, 100,-100,-100, 100,100,-100, -100,100,-100,
  -100,-100, 100, 100,-100, 100, 100,100, 100, -100,100, 100,
  0,0,-170, 0,0,170, 170,0,0, -170,0,0, 0,170,0, 0,-170,0], ZZZ);
const pointsB = pts([
  -60,-60,-60, 60,-60,-60, 60,60,-60, -60,60,-60,
  -60,-60, 60, 60,-60, 60, 60,60, 60, -60,60, 60,
  0,0,-105, 0,0,105, 105,0,0, -105,0,0, 0,105,0, 0,-105,0], QQQ);

// epolys: [sides, color, v0,v1,v2]* terminated by 0 — 24 triangles (outer object)
const epolys = [
  3,0x4002,0,1,8,  3,0x4004,1,2,8,  3,0x4006,2,3,8,  3,0x4008,3,0,8,
  3,0x400a,2,1,10, 3,0x400c,1,5,10, 3,0x400e,5,6,10, 3,0x4010,6,2,10,
  3,0x4012,2,6,12, 3,0x4014,6,7,12, 3,0x4016,7,3,12, 3,0x4018,3,2,12,
  3,0x401a,0,3,11, 3,0x401c,3,7,11, 3,0x401e,7,4,11, 3,0x4020,4,0,11,
  3,0x4022,5,1,13, 3,0x4024,1,0,13, 3,0x4026,0,4,13, 3,0x4028,4,5,13,
  3,0x402a,5,4,9,  3,0x402c,4,7,9,  3,0x402e,7,6,9,  3,0x4030,6,5,9,
  0];
// inner object: alternating colors 4/2
const epolysB = [
  3,0x4004,0,1,8,  3,0x4002,1,2,8,  3,0x4004,2,3,8,  3,0x4002,3,0,8,
  3,0x4004,2,1,10, 3,0x4002,1,5,10, 3,0x4004,5,6,10, 3,0x4002,6,2,10,
  3,0x4004,2,6,12, 3,0x4002,6,7,12, 3,0x4004,7,3,12, 3,0x4002,3,2,12,
  3,0x4004,0,3,11, 3,0x4002,3,7,11, 3,0x4004,7,4,11, 3,0x4002,4,0,11,
  3,0x4004,5,1,13, 3,0x4002,1,0,13, 3,0x4004,0,4,13, 3,0x4002,4,5,13,
  3,0x4004,5,4,9,  3,0x4002,4,7,9,  3,0x4004,7,6,9,  3,0x4002,6,5,9,
  0];

// ---------------------------------------------------------------------------
// Assets (loaded up front)
// ---------------------------------------------------------------------------
let sinT = null;      // sintable16: Int16 amplitude-32767 sine, 3600 units/circle
let cosOff = 900;     // costable16 offset into the same flat table
let sin1024 = null;   // small sine, amplitude 256, 1024 units
let fcPal = null;     // Uint8Array(768) 6-bit palette of FC pic
let fcPix = null;     // Uint8Array(64000) FC pic pixels
let titlePix = null;  // Uint8Array(w*h) SRTITLE pixels
let titlePal = null;  // Uint8Array(768) 6-bit
let titleH = 400;
let musicBytes = null;

async function loadAssets() {
  const [tabRes, fcRes, ttRes, musRes] = await Promise.all([
    fetch('assets/tables.json'), fetch('assets/fc.bin'),
    fetch('assets/srtitle.bin'), fetch('assets/music1.s3m')]);
  const tabs = await tabRes.json();
  const flat = tabs.mathsin_flat;
  const off = tabs.labels.sintable16 ?? 0;
  // keep everything from sintable16 onward; costable16 label gives cos offset
  sinT = Int16Array.from(flat.slice(off));
  if (tabs.labels.costable16 !== undefined) cosOff = tabs.labels.costable16 - off;
  sin1024 = Int16Array.from(tabs.sin1024);

  const fc = new Uint8Array(await fcRes.arrayBuffer());
  fcPal = fc.slice(16, 16 + 768);
  fcPix = fc.slice(784, 784 + 64000);

  const tt = new Uint8Array(await ttRes.arrayBuffer());
  titlePal = tt.slice(0, 768);
  let mx = 0; for (let i = 0; i < 768; i++) mx = Math.max(mx, titlePal[i]);
  if (mx > 63) for (let i = 0; i < 768; i++) titlePal[i] >>= 2;   // 8-bit CMAP -> 6-bit DAC
  titlePix = tt.slice(768);
  titleH = titlePix.length / 320;

  musicBytes = descramble(await musRes.arrayBuffer());
}

// assets/music1.s3m is a verbatim copy of MAIN/MUSIC1.S3M, whose pattern data
// is XOR-scrambled on disk (FC's anti-ripping protection; their STMIK player
// undid it at load time, which is what we do here). The keystream restarts at
// each pattern and was recovered from the scrambled files alone — see
// tools/recover_keystream.py. The order list (incl. the +++ sync markers DIS
// uses for part sync) and samples are not scrambled.
function descramble(ab) {
  const d = new Uint8Array(ab);
  const rd16 = o => d[o] | (d[o + 1] << 8);
  const key = i => {
    const n = (i >> 1) + 1;
    return (((n ^ (n >> 2)) << 3) | ((5 * i + 2) & 7)) & 0xff;
  };
  const ordnum = rd16(0x20), insnum = rd16(0x22), patnum = rd16(0x24);
  const pp = 0x60 + ordnum + insnum * 2;

  // --- pull a few things out for the console show (before we touch anything) ---
  let title = '';
  for (let i = 0; i < 28 && d[i]; i++) title += String.fromCharCode(d[i]);
  const firstPtr = (() => { for (let p = 0; p < patnum; p++) { const q = rd16(pp + p * 2) * 16; if (q) return q; } return 0; })();
  const hex = a => Array.from(a, b => b.toString(16).padStart(2, '0')).join(' ');
  const before = firstPtr ? d.slice(firstPtr + 2, firstPtr + 2 + 24) : new Uint8Array();
  const keyRow = firstPtr ? Uint8Array.from({ length: 24 }, (_, i) => key(i)) : new Uint8Array();

  let scrambledBytes = 0;
  const t0 = performance.now();
  for (let p = 0; p < patnum; p++) {
    const ptr = rd16(pp + p * 2) * 16;
    if (!ptr) continue;
    const len = rd16(ptr);
    for (let i = 0; i < len - 2; i++) { d[ptr + 2 + i] ^= key(i); scrambledBytes++; }
  }
  const dt = performance.now() - t0;
  const after = firstPtr ? d.slice(firstPtr + 2, firstPtr + 2 + 24) : new Uint8Array();

  // ------------------------------- the show -------------------------------
  const H = 'color:#7cf;font-weight:bold', DIM = 'color:#888', OK = 'color:#6f6;font-weight:bold';
  const RAW = 'color:#f66;font-family:monospace', KEY = 'color:#fc6;font-family:monospace', OUT = 'color:#6f6;font-family:monospace';
  console.group('%c♪ Second Reality — live S3M descramble %c(Future Crew anti-rip protection, undone in-browser)', H, DIM);
  console.log('%cmodule%c   "%s"', DIM, 'color:#fff', title.trim());
  console.log('%clayout%c   %d orders · %d instruments · %d patterns', DIM, 'color:#fff', ordnum, insnum, patnum);
  console.log('%cThe pattern data on disk is XOR-scrambled — a raw .s3m rip plays as noise.', 'color:#fc6');
  console.log('%cThe descrambler lived inside FC\'s private STMIK player; this keystream was', DIM);
  console.log('%crecovered from the scrambled files alone (tools/recover_keystream.py):', DIM);
  console.log('%c  key(i) = ((n ^ (n>>2)) << 3 | (5i+2 & 7)) & 0xff,  n = (i>>1)+1', 'color:#7cf;font-family:monospace');
  if (firstPtr) {
    console.log('%c\npattern 0, first 24 bytes:', 'color:#fff;font-weight:bold');
    console.log('%c  scrambled  %c%s', DIM, RAW, hex(before));
    console.log('%c  keystream  %c%s', DIM, KEY, hex(keyRow));
    console.log('%c  XOR  =     %c%s  %c← real notes', DIM, OUT, hex(after), DIM);
  }
  console.log('%c\n✔ descrambled %s bytes across %d patterns in %sms — order list + samples untouched',
    OK, scrambledBytes.toLocaleString(), patnum, dt.toFixed(2));
  console.groupEnd();

  return ab;
}

function sintable16(a) { return sinT[a]; }
function costable16(a) { return sinT[a + cosOff]; }

// ---------------------------------------------------------------------------
// Fixed point helpers (x86 semantics)
// ---------------------------------------------------------------------------
const i16 = v => (v << 16) >> 16;
// imul16 -> shld dx,ax,1  ==  ((a*b) >> 15) truncated to signed 16 bit
const m15 = (a, b) => i16(Math.imul(a, b) >> 15);

// ---------------------------------------------------------------------------
// MATH.ASM: calcmatrix (rY*rX*rZ), angle unit = 1/3600 circle
// ---------------------------------------------------------------------------
function checkdeg(v) { while (v >= 3600) v -= 3600; while (v < 0) v += 3600; return v; }

function cmatrixYXZ(rotx, roty, rotz, m /* Int16Array(9): word offsets 0..16 */) {
  // _cmatrix_yxz stores arg0 at [si+2] and arg1 at [si+0]; calcmatrix reads
  // [si+0] as its X angle — i.e. the caller's roty drives calcmatrix-X and
  // rotx drives calcmatrix-Y. Hence the name "yxz".
  const ax = checkdeg(roty), ay = checkdeg(rotx), az = checkdeg(rotz);
  const xs = sintable16(ax), xc = costable16(ax);
  const ys = sintable16(ay), yc = costable16(ay);
  const zs = sintable16(az), zc = costable16(az);
  let t14 = m15(ys, zs);            // [14] a
  const t0a = m15(yc, zc);          // [0] a
  t14 = i16(t14 - m15(t0a, xs));    // [14] -= (Ycos*Zcos)*Xsin
  const cxv = m15(xs, ys);
  const t0 = i16(t0a - m15(zs, cxv));
  let t2 = m15(zc, cxv);
  const t2b = m15(yc, zs);
  t2 = i16(t2 + t2b);
  let t12 = m15(xs, t2b);
  t12 = i16(t12 + m15(ys, zc));
  const t6 = i16(-m15(xc, zs));
  const t8 = m15(xc, zc);
  const t4 = i16(-m15(xc, ys));
  const t16 = m15(xc, yc);
  m[0] = t0; m[1] = t2; m[2] = t4;
  m[3] = t6; m[4] = t8; m[5] = xs;
  m[6] = t12; m[7] = t14; m[8] = t16;
}

// ---------------------------------------------------------------------------
// VEC.ASM: rotlist / cliplist / projlist
// pointlists: [count, x,y,z (32-bit each), ...]; projected: {sx,sy,z} arrays
// ---------------------------------------------------------------------------
const PROJ = { xmul: 256, ymul: 213, xadd: 160, yadd: 130, minz: 128 };

// current "setmatrix" state
const curM = new Int16Array(9);
let curXadd = 0, curYadd = 0, curZadd = 0;
function csetmatrix(m, xa, ya, za) { curM.set(m); curXadd = xa; curYadd = ya; curZadd = za; }

// rotlist: dst gets APPENDED (dst[0] is running count), like the asm
function crotlist(dst, src) {
  const n = src[0];
  let d = dst[0] * 3 + 1;
  dst[0] += n;
  for (let i = 0, s = 1; i < n; i++, s += 3) {
    const x = src[s], y = src[s + 1], z = src[s + 2];
    // 64-bit accumulate then >>15, truncate to int32 (shld ecx,ebx,17)
    dst[d++] = ((Math.floor((curM[0] * x + curM[1] * y + curM[2] * z) / 32768)) | 0) + curXadd | 0;
    dst[d++] = ((Math.floor((curM[3] * x + curM[4] * y + curM[5] * z) / 32768)) | 0) + curYadd | 0;
    dst[d++] = ((Math.floor((curM[6] * x + curM[7] * y + curM[8] * z) / 32768)) | 0) + curZadd | 0;
  }
}

function ccliplist(list) { // clamp view-space Y to <= 1500 (the pedestal plane)
  const n = list[0];
  for (let i = 0, s = 1; i < n; i++, s += 3) if (list[s + 1] > 1500) list[s + 1] = 1500;
}

// projected list: parallel arrays (persist like the C statics)
const prSX = new Int16Array(256), prSY = new Int16Array(256);
function cprojlist(src) {
  const n = src[0];
  for (let i = 0, s = 1; i < n; i++, s += 3) {
    const X = src[s], Y = src[s + 1];
    let Z = src[s + 2];
    if (Z < PROJ.minz) Z = PROJ.minz;
    prSY[i] = i16(((Y * PROJ.ymul) / Z | 0) + PROJ.yadd);
    prSX[i] = i16(((X * PROJ.xmul) / Z | 0) + PROJ.xadd);
  }
}

// ---------------------------------------------------------------------------
// ceasypolylist + demo modes (VEC.ASM)
// polylist layout (persistent, like `int polylist[256]`):
//   [count, color, x0,y0, x1,y1, ...]* , 0
// stored here as {n, colorIdx} views into flat Int16Array to keep the
// "stale data" semantics of the original (checkhidden may read old values).
// ---------------------------------------------------------------------------
const polyBuf = new Int16Array(512);   // persistent flat buffer
let lightshift = 9;
const rolcol = new Uint8Array(256);    // face color byte -> allocated slot
const rolused = new Uint8Array(256);   // slot -> in use
const backpal = new Uint8Array(48);    // 16 colors, 6-bit

// checkhiddenbx: 2x signed 16-bit cross product from first 3 screen points
function checkHidden(b /* index of first coord pair in polyBuf */) {
  // checkhiddenbx: (x0-x1)*(y0-y2) - (y0-y1)*(x0-x2), 16-bit operands
  const x0 = polyBuf[b], y0 = polyBuf[b + 1];
  const x1 = polyBuf[b + 2], y1 = polyBuf[b + 3];
  const x2 = polyBuf[b + 4], y2 = polyBuf[b + 5];
  const r = (Math.imul(i16(x0 - x1), i16(y0 - y2)) - Math.imul(i16(y0 - y1), i16(x0 - x2))) | 0;
  return r; // hidden if < 0
}

// demo_glz: outer object — dynamic palette blocks, lighting from projected area
function demoGlz(colorIdx, hidden, cross) {
  if (hidden) {
    const cw = polyBuf[colorIdx] & 0xffff;
    const cb = cw & 0xff;
    const slot = rolcol[cb];
    rolcol[cb] = 0;
    rolused[slot] = 0;
    // word write of AX where AH still holds the original high byte (0x40)
    polyBuf[colorIdx] = (cw & 0xff00) | (((cb >> 1) & 1) << 2);
    return;
  }
  // brightness from cross (dx:ax), exact 16-bit quirks preserved
  let bright;
  if (lightshift === 9) {
    bright = i16((cross >>> 7) & 0xffff);
  } else {
    const a8 = (cross >>> 8) & 0xffff;
    const a9 = ((a8 >>> 1) | (((cross >>> 16) & 1) << 15)) & 0xffff;
    bright = i16((a9 + a8) & 0xffff);
  }
  if (bright < 0) bright = 0; else if (bright > 63) bright = 63;

  const cw = polyBuf[colorIdx] & 0xffff;
  const cb = cw & 0xff;
  let slot = rolcol[cb];
  if (slot === 0) {
    slot = 2;
    for (let t = 0; t < 15 && rolused[slot]; t++) slot += 2;
    rolcol[cb] = slot;
    rolused[slot] = 1;
  }
  const base = (slot << 3) & 0xff;
  polyBuf[colorIdx] = (cw & 0xff00) | base;        // byte write, high byte kept

  // DAC block write: 16 entries = face color + backpal/4
  let r, g, b;
  if (cw & 2) { r = (lightshift === 9) ? 7 : 10; g = bright >> 1; b = bright; }
  else { r = bright; g = bright; b = bright; }
  for (let z = 0; z < 16; z++) {
    let rr = r + (backpal[z * 3] >> 2);
    let gg = g + (backpal[z * 3 + 1] >> 2);
    let bb = b + (backpal[z * 3 + 2] >> 2);
    if (rr > 63) rr = 63; if (gg > 63) gg = 63; if (bb > 63) bb = 63;
    const di = (base + z) * 3;
    dac[di] = rr; dac[di + 1] = gg; dac[di + 2] = bb;
  }
}

// demo_glz2: inner object — visible faces -> 0/1 (byte), hidden unchanged
function demoGlz2(colorIdx, hidden) {
  if (hidden) return;
  const cw = polyBuf[colorIdx] & 0xffff;
  polyBuf[colorIdx] = (cw & 0xff00) | ((cw >> 1) & 1);
}

// build polylist from triangles; returns end index of list
let demoFn = demoGlz;
function ceasyPolylist(polys) {
  let di = 0;          // write index into polyBuf
  let si = 0;
  let lastIdx = -1;    // adddot dedup (persists across polys within call)
  for (;;) {
    const sides = polys[si++];
    if (sides === 0) break;
    const cntIdx = di++;
    polyBuf[di++] = polys[si++];          // color
    const colorIdx = di - 1;
    const first = di;
    for (let k = 0; k < sides; k++) {
      const idx = polys[si++];
      if (idx === lastIdx) continue;
      lastIdx = idx;
      polyBuf[di++] = prSX[idx];
      polyBuf[di++] = prSY[idx];
    }
    // drop last point if it equals the first (as dword compare)
    if (di - first >= 4 &&
        polyBuf[first] === polyBuf[di - 2] && polyBuf[first + 1] === polyBuf[di - 1] &&
        di - first > 2) {
      // original compares first dword with last dword and pops one pair
      if (polyBuf[first] === polyBuf[di - 2] && polyBuf[first + 1] === polyBuf[di - 1]) di -= 2;
    }
    polyBuf[cntIdx] = (di - first) >> 1;  // vertex count
    const cross = checkHidden(first);
    demoFn(colorIdx, cross < 0, cross);
  }
  polyBuf[di] = 0;
  return di;
}

// ---------------------------------------------------------------------------
// NEW.ASM: the XOR span-transition engine ("transparent new copper")
// ---------------------------------------------------------------------------
const MAXEDGE = 512;
const neX = new Int32Array(MAXEDGE);     // 16.16 current X
const neDX = new Int32Array(MAXEDGE);
const neY2 = new Int16Array(MAXEDGE);
const neColor = new Uint16Array(MAXEDGE);
const neNext = new Int16Array(MAXEDGE);  // index+1, 0 = end
let nec = 0;
const nep = new Int16Array(256);         // bucket head: index+1, 0 = empty

// two transition lists (double buffered); entries = (offset | color<<16)
const trList = [new Uint32Array(8192), new Uint32Array(8192)];
const trLen = [1, 1];
trList[0][0] = 0xffff; trList[1][0] = 0xffff;  // initial sentinel (= dw -1)
let curTr = 0;

const activeList = new Int16Array(200);  // nl: max 128 words in original
let warnedOverflow = false;

function ngInit() {
  nec = 0;
  curTr ^= 1;
  nep.fill(0);
}

function ngAddPolys(endIdx) {
  let p = 0;
  while (p < endIdx) {
    const sides = polyBuf[p++];
    if (sides === 0) break;
    const color = polyBuf[p++] & 0xffff;
    const first = p;
    for (let e = 0; e < sides; e++) {
      const sx1 = polyBuf[p], sy1 = polyBuf[p + 1];
      const isLast = (e === sides - 1);
      const nx = isLast ? first : p + 2;
      const sx2 = polyBuf[nx], sy2 = polyBuf[nx + 1];
      p += 2;
      // order by y
      let xt, yt, xb, yb;
      if (sy1 > sy2) { xt = sx2; yt = sy2; xb = sx1; yb = sy1; }
      else { xt = sx1; yt = sy1; xb = sx2; yb = sy2; }
      if (yt === yb) continue;                       // horizontal
      const h = yb - yt;
      let X = (xt << 16) | 0;
      const DX = Math.trunc(((i16(xb - xt) << 16) | 0) / h) | 0;
      let y1 = yt;
      if (y1 < 0) {
        if (yb <= 0) continue;
        X = (X + Math.imul(DX, -y1)) | 0;
        y1 = 0;
      }
      if (y1 > 255) continue;                        // outside bucket range (orig would corrupt)
      // duplicate scan in bucket y1 (same Y2, X, DX -> byte-xor colors, drop)
      let head = nep[y1];
      let dup = false;
      for (let q = head; q !== 0; q = neNext[q - 1]) {
        const i = q - 1;
        if (neY2[i] === yb && neX[i] === X && neDX[i] === DX) {
          neColor[i] = (neColor[i] & 0xff00) | ((neColor[i] ^ color) & 0xff);
          dup = true;
          break;
        }
      }
      if (dup) continue;
      if (nec >= MAXEDGE) { if (!warnedOverflow) { console.warn('edge pool overflow'); warnedOverflow = true; } continue; }
      const i = nec++;
      neX[i] = X; neDX[i] = DX; neY2[i] = yb; neColor[i] = color;
      neNext[i] = head;
      nep[y1] = i + 1;
    }
  }
}

function ngRender() {
  // pass 2: build transition list for this frame
  const out = trList[curTr];
  let op = 0;
  let nl = 0; // active edge count
  for (let row = 0, rowAdd = 0; row < 200; row++, rowAdd += 320) {
    // add new edges for this row (bucket order = LIFO like the original)
    for (let q = nep[row]; q !== 0; q = neNext[q - 1]) {
      if (nl < activeList.length) activeList[nl++] = q - 1;
    }
    // insertion sort whole active list by X (signed 32-bit)
    for (let k = 1; k < nl; k++) {
      const e = activeList[k], x = neX[e];
      let j = k - 1;
      while (j >= 0 && x < neX[activeList[j]]) { activeList[j + 1] = activeList[j]; j--; }
      activeList[j + 1] = e;
    }
    // walk edges: emit transitions, drop finished, step X
    let lastColor = 0x8000; // the cx quirk: compared against X positions
    let w = 0;
    for (let k = 0; k < nl; k++) {
      const e = activeList[k];
      if (row >= neY2[e]) continue;      // expired -> drop
      activeList[w++] = e;
      const oldX = neX[e];
      neX[e] = (oldX + neDX[e]) | 0;
      let x = i16(oldX >> 16);
      if (x > 319) x = 319;
      if (x < 1) x = 1;
      if (lastColor === x) {
        // original bug/quirk: compares last COLOR word with X; on match, XOR
        // into the previous transition record instead of emitting a new one
        out[op - 1] = (out[op - 1] & 0xffff) | ((((out[op - 1] >>> 16) ^ neColor[e]) & 0xffff) << 16);
      } else {
        out[op++] = ((x + rowAdd) & 0xffff) | (neColor[e] << 16);
        lastColor = neColor[e];
      }
    }
    nl = w;
  }
  out[op++] = 63999;            // sentinel: offset 63999, color 0
  out[op++] = 0xffff;           // terminator
  trLen[curTr] = op;

  // pass 3: merge with previous frame's list, write only differences
  const nw = trList[curTr], od = trList[curTr ^ 1];
  let ni = 0, oi = 0;
  let ncPos = nw[0] & 0xffff, noPos = od[0] & 0xffff;
  let nCol = 0, oCol = 0;   // accumulated colors (bytes)
  let di = 0;
  for (;;) {
    if (noPos < ncPos || (noPos === ncPos && noPos !== 0xffff)) {
      // process OLD transition
      if (nCol !== oCol) { for (; di < noPos; di++) vram[di] = nCol | bgpic[di]; }
      di = noPos;
      oCol = (oCol ^ (od[oi] >>> 16)) & 0xff;
      oi++;
      noPos = od[oi] & 0xffff;
    } else if (noPos === ncPos && noPos === 0xffff) {
      break;
    } else {
      // process NEW transition
      if (nCol !== oCol) { for (; di < ncPos; di++) vram[di] = nCol | bgpic[di]; }
      di = ncPos;
      nCol = (nCol ^ (nw[ni] >>> 16)) & 0xff;
      ni++;
      ncPos = nw[ni] & 0xffff;
    }
  }
}

// ---------------------------------------------------------------------------
// Virtual VGA
// ---------------------------------------------------------------------------
const vram = new Uint8Array(64000);      // mode 13h framebuffer
const bgpic = new Uint8Array(65536);     // C global bgpic[]
const dac = new Uint8Array(768);         // 6-bit DAC
const introVram = new Uint8Array(320 * 400); // 320x400 planar mode (chunky emu)

// ---------------------------------------------------------------------------
// Music (chiptune3 / libopenmpt AudioWorklet)
// ---------------------------------------------------------------------------
let musicCtx = null, musicStart = 0, musicReady = false, chip = null;
// debug: ?silent runs on a performance clock (no audio, no click needed);
// ?jump=SECONDS starts the virtual clock offset (screenshot harness)
let silentStart = 0;
const SILENT = DEBUG.has('silent');
const JUMP = parseFloat(DEBUG.get('jump') || '0');

async function startMusic() {
  if (SILENT) { silentStart = performance.now() / 1000; musicReady = true; return; }
  const { ChiptuneJsPlayer } = await import('./vendor/chiptune3.js');
  chip = new ChiptuneJsPlayer({ repeatCount: 0 });
  await new Promise(res => { chip.onInitialized(res); });
  musicCtx = chip.context;
  // MUSIC1.S3M (clean pattern data) is a single linear song; order 0 is
  // exactly where the demo's sequencer starts it for this part.
  chip.play(musicBytes);
  musicStart = musicCtx.currentTime;
  musicReady = true;
  // calibrate clock against actual module position when progress events arrive
  chip.onProgress((d) => {
    const pos = (d && typeof d.pos === 'number') ? d.pos : null;
    if (pos !== null && pos > 0.5) {
      const drift = (musicCtx.currentTime - musicStart) - pos;
      if (Math.abs(drift) > 0.08) musicStart += drift * 0.5;
    }
  });
}

function musicTime() {
  if (!musicReady) return -1;
  if (SILENT) return performance.now() / 1000 - silentStart + JUMP;
  return musicCtx.currentTime - musicStart;
}

// ---------------------------------------------------------------------------
// Part state machine (MAIN.C main() as coroutine over 70 Hz vframes)
// ---------------------------------------------------------------------------
const S = {
  phase: 'title',      // title -> wipe -> bounce -> wait300 -> wait333 -> main -> end
  // zoomer2 state
  zy: 0, zya: 0, zly: 0, zy2: 0, zly2: 0, zframe: 0, pal1: new Uint8Array(768),
  // bounce state
  yy: 0, ya: 0,
  // main loop state (MAIN.C locals)
  frame: 0, rx: 0, ry: 0, rz: 0, zpos: 7500,
  ypos: -9000, yposa: 0, boingm: 6, boingd: 7,
  jello: 0, jelloa: 0,
  xscale: 120, yscale: 120, zscale: 120, bscale: 0,
  oxp: 0, oyp: 0, ozp: 0, oxb: 0, oyb: 0, ozb: 0,
  pal: new Uint8Array(768),   // C `pal` (copper source, first 48 bytes used)
};

function setPhase(p) { S.phase = p; if (DEBUG.has('log')) console.log('phase', p, 'mt', musicTime().toFixed(2)); }

// ---- title screen -----------------------------------------------------------
function drawTitle() {
  introVram.set(titlePix.subarray(0, 320 * Math.min(titleH, 400)));
  dac.set(titlePal);
  // BEG.C end state: colors 0..253 = picture palette, 254 = white, 255 = black
  dac[254 * 3] = 63; dac[254 * 3 + 1] = 63; dac[254 * 3 + 2] = 63;
  dac[255 * 3] = 0; dac[255 * 3 + 1] = 0; dac[255 * 3 + 2] = 0;
}

// ---- zoomer2 wipe, one vframe ----------------------------------------------
function wipeInit() {
  S.zy = 0; S.zya = 0; S.zly = 0; S.zy2 = 0; S.zly2 = 0; S.zframe = 0;
  S.pal1.set(dac);
}
function wipeFrame() {
  if (S.zy === 260) {  // done: DAC0 black + clear screen
    dac[0] = dac[1] = dac[2] = 0;
    introVram.fill(0);
    return true;
  }
  S.zly = S.zy;
  S.zya++;
  S.zy += (S.zya / 4) | 0;
  if (S.zy > 260) S.zy = 260;
  for (let y = S.zly; y <= S.zy && y < 400; y++) introVram.fill(255, y * 320, y * 320 + 320);
  S.zly2 = S.zy2;
  S.zy2 = (125 * S.zy / 260) | 0;
  let vy = 399 - S.zy2;
  for (let y = S.zly2; y <= S.zy2; y++, vy++) if (vy >= 0 && vy < 400) introVram.fill(255, vy * 320, vy * 320 + 320);
  let c = S.zframe; if (c > 32) c = 32;
  const b = 32 - c;
  for (let a = 0; a < 128 * 3; a++) dac[a] = (S.pal1[a] * b + 30 * c) >> 5;
  S.zframe++;
  return false;
}

// ---- FC pedestal bounce, one vframe -----------------------------------------
function bounceInit() {
  S.yy = 0; S.ya = 0;
  vram.fill(0);
  dac.fill(0);
  for (let a = 0; a < 48; a++) dac[a] = fcPal[a];
}
function bounceFrame() {
  S.ya++; S.yy += S.ya;
  if (S.yy > 48 * 16) {
    S.yy -= S.ya;
    S.ya = Math.trunc(-S.ya * 2 / 3);
    if (S.ya > -4 && S.ya < 4) return true;
  }
  const y = (S.yy / 16) | 0;
  const y1 = 130 + ((y / 2) | 0);
  const y2 = 130 + ((y * 3 / 2) | 0);
  let b = 0;
  if (y2 !== y1) b = (25600 / (y2 - y1)) | 0;
  let ry = y1 - 4;
  for (; ry < y1; ry++) if (ry >= 0 && ry <= 199) vram.fill(0, ry * 320, ry * 320 + 320);
  let c = 0;
  for (ry = y1; ry < y2; ry++, c += b) {
    if (ry > 199) continue;
    const src = ((c / 256) | 0) * 320;
    vram.set(fcPix.subarray(src, src + 320), ry * 320);
  }
  for (let k = 0; k < 16; k++, ry++) {
    if (ry > 199) continue;
    if (k > 7) vram.fill(0, ry * 320, ry * 320 + 320);
    else {
      const src = (100 + k) * 320;
      vram.set(fcPix.subarray(src, src + 320), ry * 320);
    }
  }
  return false;
}

// ---- palette setup at mframe 300 --------------------------------------------
function paletteSetup() {
  for (let a = 0; a < 48; a++) backpal[a] = fcPal[a];
  // tmppal: 0..15 = backpal colors; 16..255: base = backpal[a&7], +16 if a&8
  for (let a = 0; a < 256; a++) {
    const bb = a < 16 ? a : (a & 7);
    let r = backpal[bb * 3], g = backpal[bb * 3 + 1], bl = backpal[bb * 3 + 2];
    if ((a & 8) && a > 15) { r += 16; g += 16; bl += 16; }
    if (r > 63) r = 63; if (g > 63) g = 63; if (bl > 63) bl = 63;
    dac[a * 3] = r; dac[a * 3 + 1] = g; dac[a * 3 + 2] = bl;
  }
  lightshift = 9;
  S.rx = S.ry = S.rz = 0;
  S.ypos = -9000; S.yposa = 0;
  bgpic.set(vram);
  rolcol.fill(0); rolused.fill(0);
}

// ---- main loop physics, one vframe (MAIN.C while(repeat--) body) -------------
function mainPhysicsFrame() {
  S.frame++;
  const F = S.frame;
  S.rx += 32; S.ry += 7;
  S.rx %= 10800; S.ry %= 10800; S.rz %= 10800;

  if (F > 900) {
    const a = F - 900;
    let b = F - 900; if (b > 50) b = 50;
    S.oxp = Math.trunc(sin1024[(a * 3) & 1023] * b / 10);
    S.oyp = Math.trunc(sin1024[(a * 5) & 1023] * b / 10);
    S.ozp = Math.trunc((Math.trunc(sin1024[(a * 4) & 1023] / 2) + 128) * b / 16);
    if (F > 1800) {
      let aa = F - 1800 + 64;
      if (aa > 1024) aa = 1024;
      S.oxb = Math.trunc(-sin1024[(aa * 6) & 1023] * aa / 40);
      S.oyb = Math.trunc(-sin1024[(aa * 7) & 1023] * aa / 40);
      S.ozb = Math.trunc((sin1024[(aa * 8) & 1023] + 128) * aa / 40);
    } else {
      S.oxb = -sin1024[(a * 6) & 1023];
      S.oyb = -sin1024[(a * 7) & 1023];
      S.ozb = sin1024[(a * 8) & 1023] + 128;
    }
    let b2 = 1800 - F;
    if (b2 < 0) {
      if (b2 < -99) b2 = -99;
      S.oyp -= Math.trunc(b2 * b2 / 2);
    }
  }

  if (F > 800) {
    if (F > 1220 + 789) {
      if (S.xscale > 0) S.xscale -= 1;
      if (S.yscale > 0) S.yscale -= 1;
      if (S.zscale > 0) S.zscale -= 1;
      if (S.bscale > 0) S.bscale -= 1;
    } else if (F > 1400 + 789) {
      if (S.bscale > 0) S.bscale -= 8;
      if (S.bscale < 0) S.bscale = 0;
    } else {
      if (S.bscale < 180) S.bscale += 2; else S.bscale = 180;
    }
    if (S.bscale > S.xscale) lightshift = 10;
  } else {
    if (F < 640 + 70) {
      S.yposa += 31;
      S.ypos += Math.trunc(S.yposa / 40);
      if (S.ypos > -300) {
        S.ypos -= Math.trunc(S.yposa / 40);
        S.yposa = Math.trunc(-S.yposa * S.boingm / S.boingd);
        S.boingm += 2; S.boingd++;
      }
      if (S.ypos > -900 && S.yposa > 0) {
        S.jello = Math.trunc((S.ypos + 900) * 5 / 3);
        S.jelloa = 0;
      }
    } else {
      if (S.ypos > -2800) S.ypos -= 16;
      else if (S.ypos < -2800) S.ypos += 16;
    }
    S.yscale = S.xscale = 120 + Math.trunc(S.jello / 30);
    S.zscale = 120 - Math.trunc(S.jello / 30);
    const a = S.jello;
    S.jello += S.jelloa;
    if ((a < 0 && S.jello > 0) || (a > 0 && S.jello < 0)) {
      S.jelloa = Math.trunc(S.jelloa * 5 / 6);
    }
    S.jelloa -= Math.trunc(S.jello / 20);
  }

  // palette / background timeline
  if (F > 1280 + 789) {
    let b = 1280 + 789 + 64 - F;
    if (b < 0) b = 0;
    for (let a = 0; a < 48; a++) S.pal[a] = Math.trunc(backpal[a] * b / 64);
  } else if (F > 700) {
    if (F < 765) {
      let b = 764 - F;
      if (b < 0) b = 0;
      for (let a = 0; a < 48; a++) S.pal[a] = Math.trunc(backpal[a] * b / 64);
    } else if (F < 790) {
      const y = 150 + (F - 765) * 2;
      bgpic.fill(0, y * 320, y * 320 + 640);
      vram.fill(0, y * 320, y * 320 + 640);
      if (F > 785) {
        for (let a = 0; a < 16; a++) {
          let r = 0, g = 0, b = 0;
          if (a & 1) r += 10;
          if (a & 2) r += 30;
          if (a & 4) r += 20;
          if (a & 8) { r += 16; g += 16; b += 16; }
          if (r > 63) r = 63; if (g > 63) g = 63; if (b > 63) b = 63;
          backpal[a * 3] = r; backpal[a * 3 + 1] = g; backpal[a * 3 + 2] = b;
        }
      }
    } else if (F < 795) {
      S.pal.set(backpal.subarray(0, 48));
    }
  }
}

// scratch point lists (like the C statics)
const p2b = new Int32Array(256 * 3 + 1);
const p2 = new Int32Array(256 * 3 + 1);
const scaleM = new Int16Array(9);

function mainDrawFrame() {
  ngInit();

  if (S.xscale > 4) {
    demoFn = demoGlz;
    cmatrixYXZ(S.rx, S.ry, S.rz, scaleM);
    csetmatrix(scaleM, 0, 0, 0);
    p2b[0] = 0; crotlist(p2b, pointsBase);
    scaleM.fill(0);
    scaleM[0] = i16(S.xscale * 64); scaleM[4] = i16(S.yscale * 64); scaleM[8] = i16(S.zscale * 64);
    csetmatrix(scaleM, 0 + S.oxp, S.ypos + 1500 + S.oyp, S.zpos + S.ozp);
    p2[0] = 0; crotlist(p2, p2b);
    if (S.frame < 800) ccliplist(p2);
    cprojlist(p2);
    const end = ceasyPolylist(epolys);
    ngAddPolys(end);
  }

  if (S.frame > 800 && S.bscale > 4) {
    demoFn = demoGlz2;
    cmatrixYXZ(3600 - ((S.rx / 3) | 0), 3600 - ((S.ry / 3) | 0), 3600 - ((S.rz / 3) | 0), scaleM);
    csetmatrix(scaleM, 0, 0, 0);
    p2b[0] = 0; crotlist(p2b, pointsB);
    scaleM.fill(0);
    scaleM[0] = scaleM[4] = scaleM[8] = i16(S.bscale * 64);
    csetmatrix(scaleM, 0 + S.oxb, S.ypos + 1500 + S.oyb, S.zpos + S.ozb);
    p2[0] = 0; crotlist(p2, p2b);
    cprojlist(p2);
    const end = ceasyPolylist(epolysB);
    ngAddPolys(end);
  }

  ngRender();
}

// ---------------------------------------------------------------------------
// Timeline driver: virtual 70 Hz vblanks anchored to the audio clock
// ---------------------------------------------------------------------------
let vframeDone = -1;

function tick() {
  const mt = musicTime();
  if (mt < 0) return;

  if (S.phase === 'title') {
    if (mt >= MFRAME0_S) { wipeInit(); setPhase('wipe'); vframeDone = -1; }
    return;
  }

  const target = Math.floor((mt - MFRAME0_S) * VBLANK_HZ);
  let steps = target - vframeDone;
  if (steps <= 0) return;
  // don't spiral after tab-out — but allow full catch-up when jump-seeking
  if (steps > 35 && !JUMP) { vframeDone = target - 35; steps = 35; }

  for (let s = 0; s < steps; s++) {
    vframeDone++;
    switch (S.phase) {
      case 'wipe':
        if (wipeFrame()) { bounceInit(); setPhase('bounce'); switchTo200(); }
        break;
      case 'bounce':
        if (bounceFrame()) setPhase('wait300');
        break;
      case 'wait300':
        if (vframeDone >= 300) { paletteSetup(); setPhase('wait333'); }
        break;
      case 'wait333':
        if (vframeDone >= 333) {
          S.pal.set(backpal.subarray(0, 48));   // memcpy(pal, backpal)
          // then pal = DAC 0..15 read-back (same values here)
          for (let a = 0; a < 48; a++) S.pal[a] = dac[a];
          S.frame = 0;
          setPhase('main');
        }
        break;
      case 'main':
        mainPhysicsFrame();
        // copper: write pal[0..15] to DAC every vblank
        for (let a = 0; a < 48; a++) dac[a] = S.pal[a];
        if (S.frame >= END_FRAME) setPhase('end');
        break;
    }
    if (S.phase === 'end') break;
  }

  if (S.phase === 'main') mainDrawFrame();   // draw once per display frame (repeat-- semantics)
  if (S.phase === 'end') onPartEnd();
}

// ---------------------------------------------------------------------------
// Three.js display
// ---------------------------------------------------------------------------
let renderer, scene, camera, quad, idxTex, palTex, material;
let mode400 = true;

function makeIdxTex(h, buf) {
  const t = new THREE.DataTexture(buf, 320, h, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

function initGL() {
  const canvas = document.getElementById('screen');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  idxTex = makeIdxTex(400, introVram);
  palTex = new THREE.DataTexture(new Uint8Array(256 * 4), 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  palTex.magFilter = THREE.NearestFilter; palTex.minFilter = THREE.NearestFilter;

  material = new THREE.ShaderMaterial({
    uniforms: { uIdx: { value: idxTex }, uPal: { value: palTex }, uFlipY: { value: 1 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `
      varying vec2 vUv;
      uniform sampler2D uIdx, uPal;
      void main(){
        vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
        float idx = texture2D(uIdx, uv).r;
        gl_FragColor = texture2D(uPal, vec2(idx * 255.0/256.0 + 0.5/256.0, 0.5));
      }`,
  });
  quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  scene.add(quad);
  onResize();
  window.addEventListener('resize', onResize);
  document.addEventListener('fullscreenchange', onResize);
  document.addEventListener('webkitfullscreenchange', onResize);
}

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}
function onResize() {
  const W = window.innerWidth, H = window.innerHeight;
  const c = renderer.domElement;
  // fullscreen: stretch to fill the whole display, no letterbox
  if (isFullscreen()) {
    renderer.setSize(W, H, true);
    c.style.position = 'absolute';
    c.style.left = '0px';
    c.style.top = '0px';
    return;
  }
  // letterbox to 4:3
  let w = W, h = W * 3 / 4;
  if (h > H) { h = H; w = H * 4 / 3; }
  renderer.setSize(Math.round(w), Math.round(h), true);
  c.style.position = 'absolute';
  c.style.left = ((W - w) / 2) + 'px';
  c.style.top = ((H - h) / 2) + 'px';
}

function switchTo200() {
  idxTex.dispose();
  idxTex = makeIdxTex(200, vram);
  material.uniforms.uIdx.value = idxTex;
  mode400 = false;
}

function uploadTextures() {
  idxTex.needsUpdate = true;
  const p = palTex.image.data;
  for (let i = 0; i < 256; i++) {
    const v6r = dac[i * 3], v6g = dac[i * 3 + 1], v6b = dac[i * 3 + 2];
    p[i * 4] = (v6r << 2) | (v6r >> 4);
    p[i * 4 + 1] = (v6g << 2) | (v6g >> 4);
    p[i * 4 + 2] = (v6b << 2) | (v6b >> 4);
    p[i * 4 + 3] = 255;
  }
  palTex.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// End card / replay
// ---------------------------------------------------------------------------
let ended = false;
function onPartEnd() {
  if (ended) return;
  ended = true;
  const el = document.getElementById('endcard');
  el.style.display = 'flex';
  // gentle music fade-out (the demo hands off to the dot tunnel here)
  if (chip && chip.gain) {
    const g = chip.gain.gain, t = musicCtx.currentTime;
    g.setValueAtTime(1, t);
    g.linearRampToValueAtTime(0, t + 4);
    setTimeout(() => { try { chip.stop(); } catch (e) {} }, 4200);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  await loadAssets();
  initGL();
  drawTitle();
  uploadTextures();
  renderer.render(scene, camera);

  const overlay = document.getElementById('overlay');
  overlay.classList.add('ready');
  overlay.querySelector('.msg').textContent = 'CLICK TO START';

  if (SILENT) {
    overlay.style.display = 'none';
    await startMusic();
    requestAnimationFrame(loop);
    return;
  }

  overlay.addEventListener('click', async () => {
    overlay.style.display = 'none';
    await startMusic();
    requestAnimationFrame(loop);
  }, { once: true });

  document.getElementById('replay').addEventListener('click', () => location.reload());
}

function loop() {
  tick();
  uploadTextures();
  renderer.render(scene, camera);
  if (!ended) requestAnimationFrame(loop);
}

boot().catch(e => {
  document.getElementById('overlay').querySelector('.msg').textContent = 'LOAD ERROR: ' + e.message;
  console.error(e);
});
