// Second Reality — GLENZ part engine (GLENZ/MAIN.C + VEC.ASM + NEW.ASM +
// MATH.ASM), refactored from the standalone glenz-web port into a module the
// intro timeline can drive. The host owns display and music; this module owns
// the simulation: zoomer2 wipe (400-line mode), FC pedestal bounce, and the
// glenz-vector main loop with the XOR span-transition renderer.
// Original source is public domain (Unlicense, 2013 anniversary release).

const VBLANK_HZ = 70;
// dis_setmframe(0) fires when dis_musplus() >= -19: row 45 of MUSIC1 order 2,
// = 6.5187 s into the song (computed with libopenmpt). The wipe starts there.
const MFRAME0_S = 6.5187;
// dis_getmframe() TICK RATE during the wipe/bounce span.
//
// MAIN.C gates the hand-off from the FC-logo bounce into the vector main loop on
// dis_getmframe(), not on vblanks:
//     while(!dis_exit() && dis_getmframe()<300);  dis_waitb();
//     <build backpal/tmppal, reset light/rot/ypos>;  dis_waitb();
//     memcpy(bgpic,vram,64000);
//     while(!dis_exit() && dis_getmframe()<333);
// and mframe was reset by dis_setmframe(0) at the musplus gate, i.e. at
// MFRAME0_S. Those thresholds are not literal vblank counts (gframe
// 301/302/333/334): that would assume mframe advances at a clean VBLANK_HZ,
// and it does not — see techno.js's WOBBLE_END and plzpart.js's MFRAME_HZ.
// mframe is fed by the DIS interrupt chain and under-counts under heavy
// per-pixel load, and the span it
// gates here is nothing but heavy load (zoomer2's 47 frames of full-width
// memsets + a 128-entry DAC upload each, then 178 frames of scaled FC-logo
// blitting).
//
// Not derivable from source (mframe's tick source is inside MAIN/STMIK.300), so
// measured — and three independent lines agree on the same value:
//   1. plzpart.js already carries MFRAME_HZ = 52.4, capture-measured from ITS
//      heavy phase (723 ticks / 13.8 s), a completely different part.
//   2. Measuring this part in the capture: the wipe starts at video 116.02 and
//      the shape's first impact on the checkerboard is at video 124.42 (tracking
//      the lowest lit row; it reverses there and rebounds) = 8.40 s. Subtracting
//      the main loop's own 150-frame fall to impact implies 333 ticks in 6.26 s
//      = 53.2 Hz, within the measurement's ~0.05 s resolution of 52.4.
//   3. At 52.4 the impact lands on MUSIC1 order 6 row 0.6 — an ORDER boundary,
//      the strongest musical landmark available, 33 ms off. At the old 70 Hz it
//      landed on order 5 row 36.8, 182 ms off the nearest 8-row beat. The demo
//      drops the shape ON the beat, which is what made the error audible.
const MFRAME_HZ = 52.4;
// vblanks elapsed when dis_getmframe() first reads >= m
const mframeToVblank = (m) => Math.round(m * VBLANK_HZ / MFRAME_HZ);
const GATE300 = mframeToVblank(300);        // 401
const MAIN_START = mframeToVblank(333) + 1; // 446 — first main-loop physics frame
// The part exits on MAIN.C's own music gate (`a=dis_musplus(); if(a<0 && a>-16)
// break;`), which sits at a fixed MUSIC1 position: MFRAME0_S + 2600/VBLANK_HZ
// (pinned by tools/validate_s3msim.mjs). END_FRAME is therefore the remainder
// after the pre-main-loop span, so moving MAIN_START does NOT move the part end
// — only the split between the two.
const GLENZ_TOTAL_FRAMES = 2600;
const END_FRAME = GLENZ_TOTAL_FRAMES - MAIN_START;   // 2154

// --- geometry from MAIN.C ----------------------------------------------------
const ZZZ = 50, QQQ = 99;
function pts(arr, m) { const o = [arr.length / 3]; for (const v of arr) o.push(v * m); return o; }
const pointsBase = pts([
  -100,-100,-100, 100,-100,-100, 100,100,-100, -100,100,-100,
  -100,-100, 100, 100,-100, 100, 100,100, 100, -100,100, 100,
  0,0,-170, 0,0,170, 170,0,0, -170,0,0, 0,170,0, 0,-170,0], ZZZ);
const pointsB = pts([
  -60,-60,-60, 60,-60,-60, 60,60,-60, -60,60,-60,
  -60,-60, 60, 60,-60, 60, 60,60, 60, -60,60, 60,
  0,0,-105, 0,0,105, 105,0,0, -105,0,0, 0,105,0, 0,-105,0], QQQ);
const epolys = [
  3,0x4002,0,1,8,  3,0x4004,1,2,8,  3,0x4006,2,3,8,  3,0x4008,3,0,8,
  3,0x400a,2,1,10, 3,0x400c,1,5,10, 3,0x400e,5,6,10, 3,0x4010,6,2,10,
  3,0x4012,2,6,12, 3,0x4014,6,7,12, 3,0x4016,7,3,12, 3,0x4018,3,2,12,
  3,0x401a,0,3,11, 3,0x401c,3,7,11, 3,0x401e,7,4,11, 3,0x4020,4,0,11,
  3,0x4022,5,1,13, 3,0x4024,1,0,13, 3,0x4026,0,4,13, 3,0x4028,4,5,13,
  3,0x402a,5,4,9,  3,0x402c,4,7,9,  3,0x402e,7,6,9,  3,0x4030,6,5,9,
  0];
const epolysB = [
  3,0x4004,0,1,8,  3,0x4002,1,2,8,  3,0x4004,2,3,8,  3,0x4002,3,0,8,
  3,0x4004,2,1,10, 3,0x4002,1,5,10, 3,0x4004,5,6,10, 3,0x4002,6,2,10,
  3,0x4004,2,6,12, 3,0x4002,6,7,12, 3,0x4004,7,3,12, 3,0x4002,3,2,12,
  3,0x4004,0,3,11, 3,0x4002,3,7,11, 3,0x4004,7,4,11, 3,0x4002,4,0,11,
  3,0x4004,5,1,13, 3,0x4002,1,0,13, 3,0x4004,0,4,13, 3,0x4002,4,5,13,
  3,0x4004,5,4,9,  3,0x4002,4,7,9,  3,0x4004,7,6,9,  3,0x4002,6,5,9,
  0];

// --- assets -------------------------------------------------------------------
let sinT = null, cosOff = 900, sin1024 = null;
let fcPal = null, fcPix = null, titlePix = null, titlePal = null, titleH = 400;
export let music1Bytes = null;   // descrambled MUSIC1.S3M (host feeds the player)

export async function loadGlenz(descramble) {
  const [tabRes, fcRes, ttRes, musRes] = await Promise.all([
    fetch('assets/tables.json'), fetch('assets/fc.bin'),
    fetch('assets/srtitle.bin'), fetch('assets/music1.s3m')]);
  const tabs = await tabRes.json();
  const flat = tabs.mathsin_flat;
  const off = tabs.labels.sintable16 ?? 0;
  sinT = Int16Array.from(flat.slice(off));
  if (tabs.labels.costable16 !== undefined) cosOff = tabs.labels.costable16 - off;
  sin1024 = Int16Array.from(tabs.sin1024);
  const fc = new Uint8Array(await fcRes.arrayBuffer());
  fcPal = fc.slice(16, 16 + 768);
  fcPix = fc.slice(784, 784 + 64000);
  const tt = new Uint8Array(await ttRes.arrayBuffer());
  titlePal = tt.slice(0, 768);
  let mx = 0; for (let i = 0; i < 768; i++) mx = Math.max(mx, titlePal[i]);
  if (mx > 63) for (let i = 0; i < 768; i++) titlePal[i] >>= 2;
  titlePix = tt.slice(768);
  titleH = titlePix.length / 320;
  music1Bytes = descramble(await musRes.arrayBuffer());
}

const sintable16 = a => sinT[a];
const costable16 = a => sinT[a + cosOff];
const i16 = v => (v << 16) >> 16;
const m15 = (a, b) => i16(Math.imul(a, b) >> 15);

// --- MATH.ASM calcmatrix (rY*rX*rZ), 1/3600 circle -----------------------------
function checkdeg(v) { while (v >= 3600) v -= 3600; while (v < 0) v += 3600; return v; }
function cmatrixYXZ(rotx, roty, rotz, m) {
  const ax = checkdeg(roty), ay = checkdeg(rotx), az = checkdeg(rotz);
  const xs = sintable16(ax), xc = costable16(ax);
  const ys = sintable16(ay), yc = costable16(ay);
  const zs = sintable16(az), zc = costable16(az);
  let t14 = m15(ys, zs);
  const t0a = m15(yc, zc);
  t14 = i16(t14 - m15(t0a, xs));
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

// --- VEC.ASM rot/clip/proj ------------------------------------------------------
const PROJ = { xmul: 256, ymul: 213, xadd: 160, yadd: 130, minz: 128 };
const curM = new Int16Array(9);
let curXadd = 0, curYadd = 0, curZadd = 0;
function csetmatrix(m, xa, ya, za) { curM.set(m); curXadd = xa; curYadd = ya; curZadd = za; }
function crotlist(dst, src) {
  const n = src[0];
  let d = dst[0] * 3 + 1;
  dst[0] += n;
  for (let i = 0, s = 1; i < n; i++, s += 3) {
    const x = src[s], y = src[s + 1], z = src[s + 2];
    dst[d++] = ((Math.floor((curM[0] * x + curM[1] * y + curM[2] * z) / 32768)) | 0) + curXadd | 0;
    dst[d++] = ((Math.floor((curM[3] * x + curM[4] * y + curM[5] * z) / 32768)) | 0) + curYadd | 0;
    dst[d++] = ((Math.floor((curM[6] * x + curM[7] * y + curM[8] * z) / 32768)) | 0) + curZadd | 0;
  }
}
function ccliplist(list) {
  const n = list[0];
  for (let i = 0, s = 1; i < n; i++, s += 3) if (list[s + 1] > 1500) list[s + 1] = 1500;
}
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

// --- polylist + demo modes -------------------------------------------------------
const polyBuf = new Int16Array(512);
let lightshift = 9;
const rolcol = new Uint8Array(256);
const rolused = new Uint8Array(256);
const backpal = new Uint8Array(48);

function checkHidden(b) {
  const x0 = polyBuf[b], y0 = polyBuf[b + 1];
  const x1 = polyBuf[b + 2], y1 = polyBuf[b + 3];
  const x2 = polyBuf[b + 4], y2 = polyBuf[b + 5];
  return (Math.imul(i16(x0 - x1), i16(y0 - y2)) - Math.imul(i16(y0 - y1), i16(x0 - x2))) | 0;
}
function demoGlz(colorIdx, hidden, cross) {
  if (hidden) {
    const cw = polyBuf[colorIdx] & 0xffff;
    const cb = cw & 0xff;
    const slot = rolcol[cb];
    rolcol[cb] = 0;
    rolused[slot] = 0;
    polyBuf[colorIdx] = (cw & 0xff00) | (((cb >> 1) & 1) << 2);
    return;
  }
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
  polyBuf[colorIdx] = (cw & 0xff00) | base;
  let r, g, b;
  if (cw & 2) { r = (lightshift === 9) ? 7 : 10; g = bright >> 1; b = bright; }
  else { r = bright; g = bright; b = bright; }
  for (let z = 0; z < 16; z++) {
    let rr = r + (backpal[z * 3] >> 2);
    let gg = g + (backpal[z * 3 + 1] >> 2);
    let bb = b + (backpal[z * 3 + 2] >> 2);
    if (rr > 63) rr = 63; if (gg > 63) gg = 63; if (bb > 63) bb = 63;
    const di = (base + z) * 3;
    glenzDac[di] = rr; glenzDac[di + 1] = gg; glenzDac[di + 2] = bb;
  }
}
function demoGlz2(colorIdx, hidden) {
  if (hidden) return;
  const cw = polyBuf[colorIdx] & 0xffff;
  polyBuf[colorIdx] = (cw & 0xff00) | ((cw >> 1) & 1);
}
let demoFn = demoGlz;
function ceasyPolylist(polys) {
  let di = 0, si = 0, lastIdx = -1;
  for (;;) {
    const sides = polys[si++];
    if (sides === 0) break;
    const cntIdx = di++;
    polyBuf[di++] = polys[si++];
    const colorIdx = di - 1;
    const first = di;
    for (let k = 0; k < sides; k++) {
      const idx = polys[si++];
      if (idx === lastIdx) continue;
      lastIdx = idx;
      polyBuf[di++] = prSX[idx];
      polyBuf[di++] = prSY[idx];
    }
    if (di - first >= 4 &&
        polyBuf[first] === polyBuf[di - 2] && polyBuf[first + 1] === polyBuf[di - 1] &&
        di - first > 2) {
      if (polyBuf[first] === polyBuf[di - 2] && polyBuf[first + 1] === polyBuf[di - 1]) di -= 2;
    }
    polyBuf[cntIdx] = (di - first) >> 1;
    const cross = checkHidden(first);
    demoFn(colorIdx, cross < 0, cross);
  }
  polyBuf[di] = 0;
  return di;
}

// --- NEW.ASM XOR span-transition engine -------------------------------------------
const MAXEDGE = 512;
const neX = new Int32Array(MAXEDGE), neDX = new Int32Array(MAXEDGE);
const neY2 = new Int16Array(MAXEDGE);
const neColor = new Uint16Array(MAXEDGE);
const neNext = new Int16Array(MAXEDGE);
let nec = 0;
const nep = new Int16Array(256);
const trList = [new Uint32Array(8192), new Uint32Array(8192)];
const trLen = [1, 1];
let curTr = 0;
const activeList = new Int16Array(200);
let warnedOverflow = false;

function ngInit() { nec = 0; curTr ^= 1; nep.fill(0); }
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
      let xt, yt, xb, yb;
      if (sy1 > sy2) { xt = sx2; yt = sy2; xb = sx1; yb = sy1; }
      else { xt = sx1; yt = sy1; xb = sx2; yb = sy2; }
      if (yt === yb) continue;
      const h = yb - yt;
      let X = (xt << 16) | 0;
      const DX = Math.trunc(((i16(xb - xt) << 16) | 0) / h) | 0;
      let y1 = yt;
      if (y1 < 0) {
        if (yb <= 0) continue;
        X = (X + Math.imul(DX, -y1)) | 0;
        y1 = 0;
      }
      if (y1 > 255) continue;
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
  const out = trList[curTr];
  let op = 0, nl = 0;
  for (let row = 0, rowAdd = 0; row < 200; row++, rowAdd += 320) {
    for (let q = nep[row]; q !== 0; q = neNext[q - 1]) {
      if (nl < activeList.length) activeList[nl++] = q - 1;
    }
    for (let k = 1; k < nl; k++) {
      const e = activeList[k], x = neX[e];
      let j = k - 1;
      while (j >= 0 && x < neX[activeList[j]]) { activeList[j + 1] = activeList[j]; j--; }
      activeList[j + 1] = e;
    }
    let lastColor = 0x8000;
    let w = 0;
    for (let k = 0; k < nl; k++) {
      const e = activeList[k];
      if (row >= neY2[e]) continue;
      activeList[w++] = e;
      const oldX = neX[e];
      neX[e] = (oldX + neDX[e]) | 0;
      let x = i16(oldX >> 16);
      if (x > 319) x = 319;
      if (x < 1) x = 1;
      if (lastColor === x) {
        out[op - 1] = (out[op - 1] & 0xffff) | ((((out[op - 1] >>> 16) ^ neColor[e]) & 0xffff) << 16);
      } else {
        out[op++] = ((x + rowAdd) & 0xffff) | (neColor[e] << 16);
        lastColor = neColor[e];
      }
    }
    nl = w;
  }
  out[op++] = 63999;
  out[op++] = 0xffff;
  trLen[curTr] = op;
  const nw = trList[curTr], od = trList[curTr ^ 1];
  let ni = 0, oi = 0;
  let ncPos = nw[0] & 0xffff, noPos = od[0] & 0xffff;
  let nCol = 0, oCol = 0;
  let di = 0;
  for (;;) {
    if (noPos < ncPos || (noPos === ncPos && noPos !== 0xffff)) {
      if (nCol !== oCol) { for (; di < noPos; di++) glenzVram[di] = nCol | bgpic[di]; }
      di = noPos;
      oCol = (oCol ^ (od[oi] >>> 16)) & 0xff;
      oi++;
      noPos = od[oi] & 0xffff;
    } else if (noPos === ncPos && noPos === 0xffff) {
      break;
    } else {
      if (nCol !== oCol) { for (; di < ncPos; di++) glenzVram[di] = nCol | bgpic[di]; }
      di = ncPos;
      nCol = (nCol ^ (nw[ni] >>> 16)) & 0xff;
      ni++;
      ncPos = nw[ni] & 0xffff;
    }
  }
}

// --- framebuffers / palette (host reads these) --------------------------------------
export const glenzVram = new Uint8Array(64000);        // 320x200 main scene
export const glenzIntroVram = new Uint8Array(320 * 400); // 320x400 title/wipe mode
export const glenzDac = new Uint8Array(768);           // 6-bit
const bgpic = new Uint8Array(65536);
let mode400 = true;
export function glenzMode400() { return mode400; }
export function glenzEnded() { return S.phase === 'end'; }

// --- part state machine ----------------------------------------------------------
const S = {
  phase: 'title',
  zy: 0, zya: 0, zly: 0, zy2: 0, zly2: 0, zframe: 0, pal1: new Uint8Array(768),
  yy: 0, ya: 0,
  frame: 0, rx: 0, ry: 0, rz: 0, zpos: 7500,
  ypos: -9000, yposa: 0, boingm: 6, boingd: 7,
  jello: 0, jelloa: 0,
  xscale: 120, yscale: 120, zscale: 120, bscale: 0,
  oxp: 0, oyp: 0, ozp: 0, oxb: 0, oyb: 0, ozb: 0,
  pal: new Uint8Array(768),
};

function drawTitle() {
  glenzIntroVram.set(titlePix.subarray(0, 320 * Math.min(titleH, 400)));
  glenzDac.set(titlePal);
  glenzDac[254 * 3] = 63; glenzDac[254 * 3 + 1] = 63; glenzDac[254 * 3 + 2] = 63;
  glenzDac[255 * 3] = 0; glenzDac[255 * 3 + 1] = 0; glenzDac[255 * 3 + 2] = 0;
}
function wipeInit() {
  S.zy = 0; S.zya = 0; S.zly = 0; S.zy2 = 0; S.zly2 = 0; S.zframe = 0;
  S.pal1.set(glenzDac);
}
function wipeFrame() {
  if (S.zy === 260) {
    glenzDac[0] = glenzDac[1] = glenzDac[2] = 0;
    glenzIntroVram.fill(0);
    return true;
  }
  S.zly = S.zy;
  S.zya++;
  S.zy += (S.zya / 4) | 0;
  if (S.zy > 260) S.zy = 260;
  for (let y = S.zly; y <= S.zy && y < 400; y++) glenzIntroVram.fill(255, y * 320, y * 320 + 320);
  S.zly2 = S.zy2;
  S.zy2 = (125 * S.zy / 260) | 0;
  let vy = 399 - S.zy2;
  for (let y = S.zly2; y <= S.zy2; y++, vy++) if (vy >= 0 && vy < 400) glenzIntroVram.fill(255, vy * 320, vy * 320 + 320);
  let c = S.zframe; if (c > 32) c = 32;
  const b = 32 - c;
  for (let a = 0; a < 128 * 3; a++) glenzDac[a] = (S.pal1[a] * b + 30 * c) >> 5;
  S.zframe++;
  return false;
}
function bounceInit() {
  S.yy = 0; S.ya = 0;
  glenzVram.fill(0);
  glenzDac.fill(0);
  for (let a = 0; a < 48; a++) glenzDac[a] = fcPal[a];
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
  for (; ry < y1; ry++) if (ry >= 0 && ry <= 199) glenzVram.fill(0, ry * 320, ry * 320 + 320);
  let c = 0;
  for (ry = y1; ry < y2; ry++, c += b) {
    if (ry > 199) continue;
    const src = ((c / 256) | 0) * 320;
    glenzVram.set(fcPix.subarray(src, src + 320), ry * 320);
  }
  for (let k = 0; k < 16; k++, ry++) {
    if (ry > 199) continue;
    if (k > 7) glenzVram.fill(0, ry * 320, ry * 320 + 320);
    else {
      const src = (100 + k) * 320;
      glenzVram.set(fcPix.subarray(src, src + 320), ry * 320);
    }
  }
  return false;
}
// split in two to match MAIN.C's own dis_waitb() between the backpal/tmppal
// build (+ light/rot/ypos reset) and the memcpy(bgpic,vram,...) that follows it
function paletteSetupA() {
  for (let a = 0; a < 48; a++) backpal[a] = fcPal[a];
  for (let a = 0; a < 256; a++) {
    const bb = a < 16 ? a : (a & 7);
    let r = backpal[bb * 3], g = backpal[bb * 3 + 1], bl = backpal[bb * 3 + 2];
    if ((a & 8) && a > 15) { r += 16; g += 16; bl += 16; }
    if (r > 63) r = 63; if (g > 63) g = 63; if (bl > 63) bl = 63;
    glenzDac[a * 3] = r; glenzDac[a * 3 + 1] = g; glenzDac[a * 3 + 2] = bl;
  }
  lightshift = 9;
  S.rx = S.ry = S.rz = 0;
  S.ypos = -9000; S.yposa = 0;
}
function paletteSetupB() {
  bgpic.set(glenzVram);
  rolcol.fill(0); rolused.fill(0);
}
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
      glenzVram.fill(0, y * 320, y * 320 + 640);
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

// --- host interface ---------------------------------------------------------------
let gframeDone = -1;

export function glenzReset() {
  S.phase = 'title';
  S.zy = S.zya = S.zly = S.zy2 = S.zly2 = S.zframe = 0;
  S.yy = S.ya = 0;
  S.frame = 0; S.rx = S.ry = S.rz = 0; S.zpos = 7500;
  S.ypos = -9000; S.yposa = 0; S.boingm = 6; S.boingd = 7;
  S.jello = 0; S.jelloa = 0;
  S.xscale = S.yscale = S.zscale = 120; S.bscale = 0;
  S.oxp = S.oyp = S.ozp = S.oxb = S.oyb = S.ozb = 0;
  S.pal.fill(0); S.pal1.fill(0);
  glenzVram.fill(0); bgpic.fill(0);
  mode400 = true;
  gframeDone = -1;
  nec = 0; nep.fill(0); curTr = 0;
  trList[0].fill(0); trList[1].fill(0);
  trList[0][0] = 0xffff; trList[1][0] = 0xffff;
  trLen[0] = trLen[1] = 1;
  rolcol.fill(0); rolused.fill(0); backpal.fill(0);
  lightshift = 9; demoFn = demoGlz; warnedOverflow = false;
  drawTitle();
}

// advance the part to music-1 time gt (seconds since MUSIC1 started).
// Handles its own catch-up; returns true while running, false when ended.
export function glenzStepTo(gt, replay) {
  if (S.phase === 'end') return false;
  if (S.phase === 'title') {
    if (gt < MFRAME0_S) return true;
    wipeInit(); S.phase = 'wipe'; gframeDone = -1;
  }
  const target = Math.floor((gt - MFRAME0_S) * VBLANK_HZ);
  let steps = target - gframeDone;
  if (steps <= 0) return true;
  if (steps > 35 && !replay) { gframeDone = target - 35; steps = 35; }
  for (let s = 0; s < steps; s++) {
    gframeDone++;
    switch (S.phase) {
      case 'wipe':
        if (wipeFrame()) { bounceInit(); S.phase = 'bounce'; mode400 = false; }
        break;
      case 'bounce':
        if (bounceFrame()) S.phase = 'wait300';
        break;
      // MAIN.C: while(dis_getmframe()<300); dis_waitb(); <build backpal/tmppal,
      // reset light/rot/ypos>; dis_waitb(); memcpy(bgpic,vram,...); while(...<333);
      // <memcpy(pal,backpal); dis_partstart()>; dis_waitb(); <palette readback,
      // dis_setcopper()>; [main loop's own leading dis_waitb() before frame 1] --
      // 4 explicit vblank waits separate the 300-gate from the first real
      // physics frame.
      case 'wait300':
        if (gframeDone >= GATE300 + 1) { paletteSetupA(); S.phase = 'wait300b'; }
        break;
      case 'wait300b':
        if (gframeDone >= GATE300 + 2) { paletteSetupB(); S.phase = 'wait333'; }
        break;
      case 'wait333':
        if (gframeDone >= MAIN_START - 1) { S.phase = 'wait333b'; }
        break;
      case 'wait333b':
        if (gframeDone >= MAIN_START) {
          for (let a = 0; a < 48; a++) S.pal[a] = glenzDac[a];
          S.frame = 0;
          S.phase = 'main';
        }
        break;
      case 'main':
        mainPhysicsFrame();
        for (let a = 0; a < 48; a++) glenzDac[a] = S.pal[a];
        if (S.frame >= END_FRAME) S.phase = 'end';
        break;
    }
    if (S.phase === 'end') break;
  }
  if (S.phase === 'main') mainDrawFrame();
  return S.phase !== 'end';
}
