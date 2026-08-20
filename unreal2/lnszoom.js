// Second Reality — LNS&ZOOM part engine, port of LENS/MAIN.C + ASM.ASM.
// "LNS&ZOOM.EXE" combines two named parts from MAIN/U2.ASM's own comments
// ("Lens (PSI)" + "Rotazoomer (PSI)") into one shipped exe: `LENS/MAKEFILE`
// builds `lens.exe` from this source and copies it straight to
// `lns&zoom.exe`. Original source is public domain (Unlicense, 2013
// anniversary release). Runs immediately after MNTSCRL, same MUSIC1 module
// (MAIN/U2.ASM's loader skips its own `restartmus` call here for a normal
// full-demo run — confirmed by reading the `test cs:whattorun,2; jnz @@con3`
// branch immediately before this part's `partexecute` call).
//
// Reveals a demon-head picture (`LENSEXB`, a raw 320x200 `.U`-style asset,
// OMF-linked exactly like TECHNO's `_CIRCLE.OBK`/MNTSCRL's `HILLBACK.OBJ` —
// see those files' headers for the extraction precedent) in three phases:
//   1. part1: a diagonal "shutter" wipe reveal (two sweeping single-pixel
//      cursors per row, trailing revealed picture pixels behind them —
//      not a wipe fill, a genuinely sparse, streaky reveal-by-accretion).
//   2. part2: a magnifying "lens" glass bounces across the picture,
//      following a PRECOMPUTED path (`LENSEXP`'s pathdata1 — this source
//      has `#define noSAVEPATH`, so the live physics/trig that GENERATED
//      the path at build time is dead code; only the recorded path matters
//      for playback, which is exactly what got shipped in the exe).
//   3. part3: the picture is revealed via a rotating/zooming (rotozoomer)
//      effect, mode-switched to the same 640x400 "tweak mode" canvas
//      TECHNO/PANIC use, also driven by a precomputed path (pathdata2).
//
// Gates (all real `dis_musplus()` checks on MUSIC1 — derivable via
// s3msim.js, no video needed, per this project's established priority
// order): a wait before part1 (`if(dis_musplus>-30) while(dis_musplus()<
// -6);` — note the MISSING call-parens on the first comparison: `dis_musplus`
// alone is the function's ADDRESS, not a call, so `dis_musplus>-30` compares
// a code pointer against -30. Reference-video evidence (the
// demon face appears immediately, no ~30s hold) shows this evaluates FALSE
// in the shipped binary — the whole while is skipped, and the port models
// exactly that (see PREWAIT1_FRAMES below)), a second wait between part1 and
// part2 (`dis_musplus()<-20`), and part3's own early-exit gate, checked
// every frame (`if(dis_musplus()>-4) break;`).
//
// VGA mechanics: part1/part2 run in plain mode 0x13 (320x200x256, no tweak
// tricks) — `setvmode(0x13)` in main(), never touched again until part3's
// `inittwk()`. part3's rotozoomer computes a 160x100 SAMPLE grid (`ZOOMXW`/
// `ZOOMYW` in ASM.ASM), hardware-upscaled to fill this project's standard
// 320x400 displayed view (`VIEW_W`/`VIEW_H` in main.js — the same 320-wide
// output every other tweak-mode part in this port ultimately writes into,
// regardless of how many "virtual" pixels the DOS original's own plane
// addressing spanned internally): `inittwk`'s CRTC Maximum-Scan-Line
// register write (`...or al,3...`) sets a 4x VERTICAL scanline repeat
// (100*4=400, confirmed by a real hardware register, not inferred), and
// the sample-to-display width ratio follows directly from this project's
// fixed 320-pixel-wide output (320/160=2x HORIZONTAL) — note this is a
// different ratio than TECHNO's own 640-wide *virtual panning* canvas
// (bgVal/animBit), which represents pannable off-screen content, not a
// display-resolution upscale; the two aren't the same kind of "640" and
// shouldn't be conflated. Modeled directly as a 2x/4x nearest-neighbor
// upscale from the 160x100 sample buffer, sidestepping the real segmented-
// addressing/plane-mask trick entirely (the same "flat decoded array, no
// loss of fidelity" approach used throughout this port). Verified in a
// from-scratch Python simulation (both the magnifying-lens compositing and
// the rotozoomer's fixed-point sampling) before porting, per this
// project's established methodology.
//
// The lens effect's own remap tables (`LENSEX1`-`LENSEX4`, OMF-linked raw
// data) are three DIFFERENT per-row record formats, precisely traced from
// `_dorow`/`_dorow2`/`_dorow3` in ASM.ASM and independently bounds-validated
// against the real extracted binaries (every row's declared byte length
// matches its data exactly, zero slack):
//   lens1 ("seq", used by `_dorow`, tint mask 0x40): per row, a u16 dest-
//     offset `delta` then `count` x i16 SOURCE deltas — destinations are
//     IMPLICITLY sequential (di, di+1, di+2, ...) starting at delta; only
//     the source position varies per pixel (this is the lens's solid
//     interior — cheap to encode since consecutive output pixels don't
//     need their own destination address).
//   lens2/lens3 ("pair", `_dorow2`, masks 0x80/0xC0): per row, `delta` then
//     `count` x (i16 dest-delta, i16 src-delta) pairs — a fully sparse,
//     explicit remap (the lens's ring/edge detail, needing non-contiguous
//     destinations).
//   lens4 ("combo", `_dorow3`, no tint): per row, `delta` then `count` x
//     i16 offset, where the SAME offset is used for both source and
//     destination — a pure untinted passthrough (drawn last, likely the
//     lens's outer rim/edge cleanup, overwriting any lens1-3 bleed at the
//     boundary with plain unmagnified background).
// `LENSEX0` holds the lens's own pixel dimensions (152x116) plus 3 RGB
// tint triples used to build 3 extra 64-color palette blocks (indices
// 64-127/128-191/192-255, each `min(63, tint+basePaletteValue)`) that
// lens1/2/3's masks select into — progressively bluer as you go from the
// interior (lens1, mildest tint) to the outer ring (lens3, strongest).
// (LENSEX0 also contains an inert, never-read "easter egg" — an encrypted
// text message past the 13 bytes the program actually uses. Not extracted
// into this port's asset file; irrelevant to playback.)

const VBLANK_HZ = 70;
const trunc = (a, b) => (a / b) | 0;

// --- assets ---
let bgPix = null, bgPal = null;      // LENSEXB: 320x200 picture + its own 6-bit palette (indices 0-63)
let lenswid = 152, lenshig = 116, lensxs = 76, lensys = 58;
let tints = null;                     // [[r,g,b],[r,g,b],[r,g,b]]
let lens1 = null, lens2 = null, lens3 = null, lens4 = null;   // per-row parsed tables
let pathdata1 = null;   // Int16Array(715*2) -- part2's (x,y) per frame
let pathdata2 = null;   // Int16Array(2000*4) -- part3's (x,y,xa,ya) per frame
let rotpic = null, rotpic90 = null;   // Uint8Array(65536) each, built once from bgPix
let fade = null, fade2 = null;        // palette fade tables, see loadLnszoom()

const palette = new Uint8Array(768);   // full 256-color palette (block0 = bgPal, blocks1-3 = tinted)

function parseLensTable(bytes, mode) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rows = new Array(lenshig);
  for (let y = 0; y < lenshig; y++) {
    const off = dv.getUint16(y * 4, true), cnt = dv.getUint16(y * 4 + 2, true);
    if (cnt < 4) { rows[y] = null; continue; }
    const delta = dv.getInt16(off, true);
    const n = mode === 'pair' ? cnt * 2 : cnt;
    const entries = new Int16Array(n);
    for (let i = 0; i < n; i++) entries[i] = dv.getInt16(off + 2 + i * 2, true);
    rows[y] = { delta, entries };
  }
  return rows;
}

export async function loadLnszoom() {
  const [bgRes, ex0Res, ex1Res, ex2Res, ex3Res, ex4Res, expRes] = await Promise.all([
    fetch('assets/lensbg.bin'), fetch('assets/lensex0.bin'),
    fetch('assets/lensex1.bin'), fetch('assets/lensex2.bin'),
    fetch('assets/lensex3.bin'), fetch('assets/lensex4.bin'),
    fetch('assets/lensexp.bin')]);
  const bg = new Uint8Array(await bgRes.arrayBuffer());
  bgPal = bg.slice(0, 768);
  bgPix = bg.slice(768, 768 + 320 * 200);

  const ex0 = new Uint8Array(await ex0Res.arrayBuffer());
  const ex0dv = new DataView(ex0.buffer);
  lenswid = ex0dv.getUint16(0, true); lenshig = ex0dv.getUint16(2, true);
  lensxs = trunc(lenswid, 2); lensys = trunc(lenshig, 2);
  tints = [0, 1, 2].map(i => [ex0[4 + i * 3], ex0[5 + i * 3], ex0[6 + i * 3]]);

  lens1 = parseLensTable(new Uint8Array(await ex1Res.arrayBuffer()), 'seq');
  lens2 = parseLensTable(new Uint8Array(await ex2Res.arrayBuffer()), 'pair');
  lens3 = parseLensTable(new Uint8Array(await ex3Res.arrayBuffer()), 'pair');
  lens4 = parseLensTable(new Uint8Array(await ex4Res.arrayBuffer()), 'combo');

  const exp = new Uint8Array(await expRes.arrayBuffer());
  const expDv = new DataView(exp.buffer);
  const a = expDv.getUint16(2, true);
  pathdata1 = new Int16Array(a);
  for (let i = 0; i < a; i++) pathdata1[i] = expDv.getInt16(4 + i * 2, true);
  const off2 = 4 + 2 * a;
  const quads = trunc(exp.length - off2, 2);
  pathdata2 = new Int16Array(quads);
  for (let i = 0; i < quads; i++) pathdata2[i] = expDv.getInt16(off2 + i * 2, true);

  // full 256-color palette: block0 = picture's own palette, blocks1-3 = tinted copies
  palette.set(bgPal.subarray(0, 192), 0);
  for (let i = 0; i < 3; i++) {
    const [r, g, b] = tints[i];
    for (let a2 = 0; a2 < 192; a2 += 3) {
      palette[a2 + (i + 1) * 192 + 0] = Math.min(63, r + palette[a2 + 0]);
      palette[a2 + (i + 1) * 192 + 1] = Math.min(63, g + palette[a2 + 1]);
      palette[a2 + (i + 1) * 192 + 2] = Math.min(63, b + palette[a2 + 2]);
    }
  }

  // rotpic/rotpic90: 256x256 built once from bgPix (KOE.C-equivalent in MAIN.C)
  rotpic = new Uint8Array(65536);
  for (let x = 0; x < 256; x++) {
    for (let y = 0; y < 256; y++) {
      let ry = trunc(y * 10, 11) - 18;
      if (ry < 0 || ry > 199) ry = 0;
      rotpic[x + y * 256] = bgPix[x + 32 + ry * 320];
    }
  }
  rotpic90 = new Uint8Array(65536);
  for (let x = 0; x < 256; x++) for (let y = 0; y < 256; y++) rotpic90[x + y * 256] = rotpic[y + (255 - x) * 256];

  // `fade`: 64 blocks (indices 0-63 of the FULL 256-color palette, i.e. the
  // untinted base only) ramping palette->white as block index increases,
  // then 16 MORE blocks ramping an ADDITIVE white-overshoot back down to
  // the exact palette -- part3 uses block (64+frame) for frame<16 (a quick
  // white-flash-settle intro) and block a=(frame-1872)/2 (clamped 63) near
  // its nominal 2000-frame cap (a fade-to-white outro, in practice rarely
  // reached since the real musplus() exit gate almost always fires first).
  fade = new Uint8Array(80 * 192);
  { let p = 0;
    for (let x = 0; x < 64; x++) for (let y = 0; y < 192; y++) fade[p++] = trunc(palette[y] * (63 - x) + x * 63, 63);
    for (let x = 0; x < 16; x++) for (let y = 0; y < 192; y++) fade[p++] = Math.min(63, palette[y] + (15 - x) * 5);
  }
  // `fade2`: 32 blocks of 576 bytes (192 TINTED colors, indices 64-255)
  // ramping from "mostly just the tint delta" (near-black) at block0 up to
  // the full tinted color at block31 -- part2 uses this for its own
  // 64-vblank tint fade-in (`uframe` 32-95), so the lens's colored
  // refraction rings don't flash in at full saturation immediately.
  fade2 = new Uint8Array(32 * 576);
  { let p = 0;
    for (let x = 0; x < 32; x++) for (let y = 192; y < 768; y++) {
      const base = palette[y % 192];
      fade2[p++] = palette[y] - trunc(base * (31 - x), 31);
    }
  }

  console.log('[LNSZOOM] demon-head picture + lens tables + rotozoomer path loaded');
}

export const lnszoomVram = new Uint8Array(320 * 200);     // part1/part2 (plain mode 0x13)
export const lnszoomVram400 = new Uint8Array(320 * 400);  // part3 (tweak mode, matches this project's 400-line view convention)
export const lnszoomPal = new Uint8Array(768);

let frame = -1;
let phase = 'prewait1';   // 'prewait1' -> 'part1' -> 'prewait2' -> 'part2' -> 'part3' -> 'done'
let phaseFrame = 0;        // frame index within the current phase

// part1 state
const firfade1 = new Int32Array(200), firfade2 = new Int32Array(200);
const firfade1a = new Int32Array(200), firfade2a = new Int32Array(200);

export function lnszoomMode400() { return phase === 'part3'; }

// --- lens table renderers (see header for the exact per-format semantics) ---
function dorowSeq(table, di0, row, mask) {
  const rec = table[row];
  if (!rec) return;
  let di = di0 + rec.delta;
  const e = rec.entries;
  for (let i = 0; i < e.length; i++) {
    const si = di + e[i];
    if (di >= 0 && di < 64000 && si >= 0 && si < 64000) lnszoomVram[di] = bgPix[si] | mask;
    di++;
  }
}
function dorowPair(table, di0, row, mask) {
  const rec = table[row];
  if (!rec) return;
  const base = di0 + rec.delta, e = rec.entries;
  for (let i = 0; i < e.length; i += 2) {
    const di = base + e[i], si = base + e[i + 1];
    if (di >= 0 && di < 64000 && si >= 0 && si < 64000) lnszoomVram[di] = bgPix[si] | mask;
  }
}
function dorowCombo(table, di0, row) {
  const rec = table[row];
  if (!rec) return;
  const base = di0 + rec.delta, e = rec.entries;
  for (let i = 0; i < e.length; i++) {
    const di = base + e[i];
    if (di >= 0 && di < 64000) lnszoomVram[di] = bgPix[di];
  }
}
function drawlens(x0, y0) {
  let u1 = (x0 - lensxs) + (y0 - lensys) * 320;
  let u2 = (x0 - lensxs) + (y0 + lensys - 1) * 320;
  const ys = trunc(lenshig, 2), ye = lenshig - 1;
  for (let y = 0; y < ys; y++) {
    if (u1 >= 0 && u1 <= 64000) {
      dorowSeq(lens1, u1, y, 0x40); dorowPair(lens2, u1, y, 0x80);
      dorowPair(lens3, u1, y, 0xC0); dorowCombo(lens4, u1, y);
    }
    u1 += 320;
    if (u2 >= 0 && u2 <= 64000) {
      dorowSeq(lens1, u2, ye - y, 0x40); dorowPair(lens2, u2, ye - y, 0x80);
      dorowPair(lens3, u2, ye - y, 0xC0); dorowCombo(lens4, u2, ye - y);
    }
    u2 -= 320;
  }
}

// --- part3: rotozoomer, exact fixed-point port of ASM.ASM's `_rotate` ---
// (see header for the asymmetric pre/post aspect-ratio-correction subtlety
// and the row/column basis-vector derivation -- validated in a standalone
// Python simulator before porting, per this project's established practice)
const ZOOMXW = 160, ZOOMYW = 100;
const colOffsets = new Int32Array(ZOOMXW);
const rotOut = new Uint8Array(ZOOMXW * ZOOMYW);
function s16(v) { v &= 0xffff; return v; }
function rotate(x0, y0, xa, ya) {
  // Exact port of ASM.ASM _rotate(x, y, xa, ya) — C far args at bp+6..+12.
  // When |xa*64| > |ya*64|, sample rotpic90 and re-base axes as:
  //   xchg eax,ebx; neg eax     → eax=-old_ebx, ebx=old_eax
  //   xchg xpos,ypos; neg xpos  → xpos=-old_ypos, ypos=old_xpos
  // Note the sign: xpos=-old_ypos, not +. The mirrored form makes the path
  // bounce discontinuously whenever the |xa|/|ya| branch flips mid-animation.
  let xpos = x0 * 65536, ypos = y0 * 65536;
  let eax = xa * 64, ebx = ya * 64;
  let ecx = eax, edx = ebx;
  let tex = rotpic;
  const aecx = ecx < 0 ? -ecx : ecx, aedx = edx < 0 ? -edx : edx;
  if (aecx > aedx) {
    tex = rotpic90;
    const oldEax = eax;
    eax = -ebx;
    ebx = oldEax;
    const oldXpos = xpos;
    xpos = -ypos;
    ypos = oldXpos;
  }
  const xaddRaw = eax, yaddRaw = ebx;

  // column-step precompute (uses PRE-aspect-correction deltas)
  let cx = s16(yaddRaw), dx = s16(xaddRaw);
  let bl = (yaddRaw >> 16) & 0xff, bh = (xaddRaw >> 16) & 0xff;
  let dxNeg = s16(-dx);
  const borrow = dx !== 0 ? 1 : 0;
  bh = (256 - bh - borrow) & 0xff;
  dx = dxNeg;
  let si = 0, di = 0, al = 0, ah = 0;
  for (let k = 0; k < ZOOMXW; k++) {
    let s = si + cx; const c1 = s > 0xffff ? 1 : 0; si = s & 0xffff;
    al = (al + bl + c1) & 0xff;
    let d = di + dx; const c2 = d > 0xffff ? 1 : 0; di = d & 0xffff;
    ah = (ah + bh + c2) & 0xff;
    colOffsets[k] = (ah << 8) | al;
  }

  // aspect-ratio correction (POST column-step; only affects row stepping)
  const xadd = (xaddRaw * 307) >> 8, yadd = (yaddRaw * 307) >> 8;

  for (let row = 0; row < ZOOMYW; row++) {
    ypos += yadd; xpos += xadd;
    // ASM.ASM _rotate: after `shr ebx,8` on ypos, BH holds original ypos[23:16]
    // (= (ypos>>16)&0xff); then `mov bl,al` writes (xpos>>16)&0xff into BL.
    // si = BX = ((ypos>>16)&0xff)<<8 | ((xpos>>16)&0xff). Note >>16 and not
    // >>8 for the high byte: >>8 samples the wrong texture row and smears the
    // face horizontally.
    const rowBase = (((ypos >> 16) & 0xff) << 8) | ((xpos >> 16) & 0xff);
    const rowOff = row * ZOOMXW;
    for (let col = 0; col < ZOOMXW; col++) {
      const off = (rowBase + colOffsets[col]) & 0xffff;
      rotOut[rowOff + col] = tex[off];
    }
  }
}

function blitRotOut400() {
  // 2x horizontal / 4x vertical nearest-neighbor upscale, 160x100 -> this
  // project's standard 320x400 displayed view -- see header for the
  // CRTC-scanline-repeat-derived 4x and the 320-wide-output-derived 2x
  for (let y = 0; y < 400; y++) {
    const sy = y >> 2, rowIn = sy * ZOOMXW, rowOut = y * 320;
    for (let x = 0; x < 320; x++) lnszoomVram400[rowOut + x] = rotOut[rowIn + (x >> 1)];
  }
}

// --- phase budgets (LENS/MAIN.C) ---
// Gate1: `if(dis_musplus>-30) while(dis_musplus()<-6);` — missing () on the
// outer check means it compares the function ADDRESS to -30. In the shipped
// binary this evaluates false (video: no ~30s wait; face appears immediately),
// so only the trailing dis_waitb() runs → 1 frame.
// Gate2: real `while(dis_musplus()<-20);` busy-wait after part1, then
// dis_waitb(). Driven live/s3msim via musplusAtLocal, not a baked frame count.
// part3: each frame `if(dis_musplus()>-4) break;` + hard cap frame<2000.
const PREWAIT1_FRAMES = 2;         // main():370 waitb() + part1():105 dis_waitb()
const PART1_FRAMES = 300;
const PART2_FRAMES = 720;          // 715 active + 5 idle tail
const PART3_MAX_FRAMES = 2000;

export function lnszoomReset() {
  frame = -1; phase = 'prewait1'; phaseFrame = 0;
  for (let y = 0; y < 200; y++) {
    firfade1a[y] = (19 + trunc(y, 5) + 4) & ~7;
    firfade2a[y] = -((19 + trunc(199 - y, 5) + 4) & ~7);
    firfade1[y] = 170 * 64 + (100 - y) * 50;
    firfade2[y] = 170 * 64 + (100 - y) * 50;
  }
  lnszoomVram.fill(0); lnszoomVram400.fill(0); lnszoomPal.fill(0);
  lnszoomPal.set(palette);   // main() sets the real palette right away (setpalarea before part1) -- vram is still all-0/black, so this is invisible until part1's sweep begins
}

function stepPart1() {
  if (phaseFrame < 80) {
    for (let c = 0; c < 6; c++) {
      for (let y = 0; y < 200; y++) {
        let x = firfade1[y] >> 6;
        if (x >= 0 && x < 320) lnszoomVram[y * 320 + x] = bgPix[y * 320 + x];
        x = firfade2[y] >> 6;
        if (x >= 0 && x < 320) lnszoomVram[y * 320 + x] = bgPix[y * 320 + x];
        firfade1[y] += firfade1a[y];
        firfade2[y] += firfade2a[y];
      }
    }
  }
  phaseFrame++;
  if (phaseFrame >= PART1_FRAMES) { phase = 'prewait2'; phaseFrame = 0; }
}

function stepPart2() {
  if (phaseFrame < 96) {
    let a = trunc(phaseFrame - 32, 2);
    if (a < 0) a = 0;
    // setpalarea(fade2+a*3*192, 64, 192): overwrite palette indices 64-255
    // (192 colors) from fade2 block `a` -- see loadLnszoom()'s derivation
    lnszoomPal.set(fade2.subarray(a * 576, a * 576 + 576), 192);
  }
  if (phaseFrame < 715) {
    const x0 = pathdata1[phaseFrame * 2], y0 = pathdata1[phaseFrame * 2 + 1];
    drawlens(x0, y0);
  }
  phaseFrame++;
  if (phaseFrame >= PART2_FRAMES) {
    phase = 'part3'; phaseFrame = 0;
    // mode switch: inittwk() clears the palette and vram -- our 400-line
    // canvas starts fresh, matching source exactly
    lnszoomVram400.fill(0); lnszoomPal.fill(0);
  }
}

function stepPart3(musplusAtLocal) {
  // LENS/MAIN.C: if(dis_musplus()>-4) break; each frame before work
  const localS = frame / VBLANK_HZ;
  const m = musplusAtLocal ? musplusAtLocal(localS) : -32;
  if (m > -4) { phase = 'done'; return; }
  if (phaseFrame < 16) {
    lnszoomPal.set(fade.subarray((64 + phaseFrame) * 192, (64 + phaseFrame) * 192 + 192), 0);
  }
  const x0 = pathdata2[phaseFrame * 4], y0 = pathdata2[phaseFrame * 4 + 1];
  const xa = pathdata2[phaseFrame * 4 + 2], ya = pathdata2[phaseFrame * 4 + 3];
  rotate(x0, y0, xa, ya);
  blitRotOut400();
  phaseFrame++;
  if (phaseFrame >= PART3_MAX_FRAMES - 128) {
    let a = trunc(phaseFrame - (PART3_MAX_FRAMES - 128), 2);
    if (a > 63) a = 63;
    lnszoomPal.set(fade.subarray(a * 192, a * 192 + 192), 0);
  }
  if (phaseFrame >= PART3_MAX_FRAMES) { phase = 'done'; }
}

function stepOneFrame(musplusAtLocal) {
  frame++;
  const localS = frame / VBLANK_HZ;
  const getM = musplusAtLocal || (() => -32);

  if (phase === 'prewait1') {
    phaseFrame++;
    if (phaseFrame >= PREWAIT1_FRAMES) { phase = 'part1'; phaseFrame = 0; }
    return;
  }
  if (phase === 'prewait2') {
    // while(dis_musplus()<-20); then dis_waitb — busy-wait on music, then 1 vb
    if (getM(localS) >= -20) {
      phaseFrame++;
      if (phaseFrame >= 1) { phase = 'part2'; phaseFrame = 0; }
    } else {
      phaseFrame = 0; // stay until musplus opens, then one waitb
    }
    return;
  }
  if (phase === 'part1') { stepPart1(); return; }
  if (phase === 'part2') { stepPart2(); return; }
  if (phase === 'part3') { stepPart3(musplusAtLocal); return; }
}

export function lnszoomEnded() { return phase === 'done'; }
export function lnszoomLocalFrames() { return frame; }
export function lnszoomDurationS() {
  return Math.max(0, frame) / VBLANK_HZ;
}

// tt = seconds since LNS&ZOOM part start. musplusAtLocal(s) for music gates.
export function lnszoomStepTo(tt, replay, musplusAtLocal) {
  if (phase === 'done') return false;
  const target = Math.floor(tt * VBLANK_HZ);
  let steps = target - frame;
  if (steps <= 0) return true;
  if (steps > 35 && !replay) steps = 35;
  for (let s = 0; s < steps && phase !== 'done'; s++) stepOneFrame(musplusAtLocal);
  return phase !== 'done';
}
