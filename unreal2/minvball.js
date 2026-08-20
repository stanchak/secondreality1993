// MINVBALL -- MiniVectorBalls (PSI).
//
// This is a literal browser translation of DOTS/MAIN.C and DOTS/ASM.ASM's
// current 3-row drawdots implementation.  Keep the 16-bit wrapping, signed
// divides, old-pixel restoration, and update order here: all four are visible
// parts of the original effect, not implementation details to "clean up".

const VBLANK_HZ = 70;
const DOTNUM = 512;                     // MAIN.C:91
const STARTUP_FADE_TICKS = 65 * 2;      // MAIN.C:171-183
const LAST_MAIN_FRAME = 2450;           // MAIN.C:185

const s16 = value => (value << 16) >> 16;
const u16 = value => value & 0xffff;
const idiv = (numerator, denominator) => Math.trunc(numerator / denominator);

// Mode 13h exposes a complete 64K A000 segment even though only its first
// 64000 bytes are visible.  drawdots can touch the tail when a sprite starts
// on row 198/199, so retain it internally and export only the visible view.
const vgaSegment = new Uint8Array(0x10000);
export const minvballVram = vgaSegment.subarray(0, 320 * 200);
export const minvballPal = new Uint8Array(768);

let sin1024 = null;
const isin = degrees => sin1024[degrees & 1023];       // MAIN.C:32-35
const icos = degrees => sin1024[(degrees + 256) & 1023]; // MAIN.C:37-40

const cols = [
  0, 0, 0,
  4, 25, 30,
  8, 40, 45,
  16, 55, 60,
]; // MAIN.C:72-76

// ASM.ASM:34-36. oldShadow/oldBall are the +6/+8 word fields used by the
// background restoration path; omitting them changes overlap artifacts.
const dots = Array.from({ length: DOTNUM }, () => ({
  x: 0, y: 0, z: 0, oldShadow: 0, oldBall: 0, yadd: 0,
}));

const depthtable1 = new Uint32Array(128);
const depthtable2 = new Uint32Array(128);
const depthtable3 = new Uint32Array(128);
const dottaul = new Uint16Array(DOTNUM);
const pal = new Uint8Array(768);
const pal2 = new Uint8Array(768);
const bgpic = new Uint8Array(0x10000);

let rngState = 1;
let localTick = 0;
let fadeTick = 0;
let frame = 0;
let done = false;
let doneAtLocal = null;
let dropper = 22000;
let grav = 3;
let gravd = 13;
let gravitybottom = 8105;
let rot = 0;
let rots = 0;
let rota = -64;
let fctr = 0;
let dotCursor = 0;

// Microsoft C 6's runtime rand(): the executable is linked against the 1990
// Microsoft run-time and does not call srand(), so its initial seed is one.
function msRand() {
  rngState = (Math.imul(rngState, 214013) + 2531011) >>> 0;
  return (rngState >>> 16) & 0x7fff;
}

function buildDepthTables() {
  // MAIN.C:156-167.  `int` is 16-bit, so (43+20)/2 is 31 (not 31.5).
  for (let a = 0; a < 128; a++) {
    let c = idiv((a - 31) * 3, 4) + 8;
    if (c < 0) c = 0;
    else if (c > 15) c = 15;
    c = 15 - c;
    depthtable1[a] = (0x00000202 + Math.imul(0x04040404, c)) >>> 0;
    depthtable2[a] = (0x02030302 + Math.imul(0x04040404, c)) >>> 0;
    depthtable3[a] = depthtable1[a];
  }
}

// IBM VGA's mode-13h BIOS palette: 16 EGA colours, 16 greys, then nine
// 24-colour hue rings. A mode set writes entries 0..247; the final eight DAC
// entries retain their BIOS-initialized zero. DOTS reads the whole DAC after
// overriding only selected ranges, so the untouched 164..247 tail matters to
// the exact palette state even though its current framebuffer does not index it.
function loadMode13Palette(target) {
  target.fill(0);
  const ega = [
    [0, 0, 0], [0, 0, 42], [0, 42, 0], [0, 42, 42],
    [42, 0, 0], [42, 0, 42], [42, 21, 0], [42, 42, 42],
    [21, 21, 21], [21, 21, 63], [21, 63, 21], [21, 63, 63],
    [63, 21, 21], [63, 21, 63], [63, 63, 21], [63, 63, 63],
  ];
  const greys = [0, 5, 8, 11, 14, 17, 20, 24, 28, 32, 36, 40, 45, 50, 56, 63];
  let index = 0;
  for (const rgb of ega) target.set(rgb, index++ * 3);
  for (const value of greys) target.fill(value, index * 3, ++index * 3);
  const rings = [
    [0, 16, 31, 47, 63], [31, 39, 47, 55, 63], [45, 49, 54, 58, 63],
    [0, 7, 14, 21, 28], [14, 17, 21, 24, 28], [20, 22, 24, 26, 28],
    [0, 4, 8, 12, 16], [8, 10, 12, 14, 16], [11, 12, 13, 15, 16],
  ];
  for (const [lo, q1, q2, q3, hi] of rings) {
    const ring = [
      [lo, lo, hi], [q1, lo, hi], [q2, lo, hi], [q3, lo, hi],
      [hi, lo, hi], [hi, lo, q3], [hi, lo, q2], [hi, lo, q1],
      [hi, lo, lo], [hi, q1, lo], [hi, q2, lo], [hi, q3, lo],
      [hi, hi, lo], [q3, hi, lo], [q2, hi, lo], [q1, hi, lo],
      [lo, hi, lo], [lo, hi, q1], [lo, hi, q2], [lo, hi, q3],
      [lo, hi, hi], [lo, q3, hi], [lo, q2, hi], [lo, q1, hi],
    ];
    for (const rgb of ring) target.set(rgb, index++ * 3);
  }
  if (index !== 248) throw new Error(`mode 13h palette generated ${index} entries`);
}

function buildPaletteAndBackground() {
  // int 10h/13h clears VRAM and installs the IBM 248-colour BIOS palette.
  loadMode13Palette(pal);
  for (let a = 0; a < 16; a++) {
    const brightness = 100 + a * 9;
    for (let b = 0; b < 4; b++) {
      const p = (a * 4 + b) * 3;
      pal[p] = cols[b * 3];
      pal[p + 1] = idiv(cols[b * 3 + 1] * brightness, 256);
      pal[p + 2] = idiv(cols[b * 3 + 2] * brightness, 256);
    }
  } // MAIN.C:127-134

  pal[255 * 3] = 31;
  pal[255 * 3 + 1] = 0;
  pal[255 * 3 + 2] = 15; // MAIN.C:135-138

  for (let a = 0; a < 100; a++) {
    let c = 64 - idiv(256, a + 4);
    c = idiv(c * c, 64);
    const value = idiv(c, 4);
    const p = (a + 64) * 3;
    pal[p] = value;
    pal[p + 1] = value;
    pal[p + 2] = value;
  } // MAIN.C:139-147

  vgaSegment.fill(0);
  for (let a = 0; a < 100; a++) {
    vgaSegment.fill(a + 64, (100 + a) * 320, (101 + a) * 320);
  } // MAIN.C:150-155
  bgpic.fill(0);
  bgpic.set(minvballVram); // MAIN.C:168-169
}

export async function loadMinvball() {
  const response = await fetch('assets/tables.json');
  if (!response.ok) throw new Error(`MINVBALL tables: HTTP ${response.status}`);
  const tables = await response.json();
  if (!Array.isArray(tables.sin1024) || tables.sin1024.length !== 1024) {
    throw new Error('MINVBALL tables: DOTS/SIN1024.INC must contain 1024 words');
  }
  sin1024 = Int16Array.from(tables.sin1024);
  buildDepthTables();
  console.log('[MINVBALL] exact DOTS tables ready');
}

function scrambleInitialState() {
  // These apparently redundant loops matter: the two 500-swap passes consume
  // 2000 rand() calls before the frame>=1700 particle burst (MAIN.C:92-123).
  for (let a = 0; a < DOTNUM; a++) dottaul[a] = a;
  for (let a = 0; a < 500; a++) {
    const b = msRand() % DOTNUM;
    const c = msRand() % DOTNUM;
    const value = dottaul[b];
    dottaul[b] = dottaul[c];
    dottaul[c] = value;
  }

  for (let a = 0; a < DOTNUM; a++) {
    const d = dots[a];
    d.x = 0;
    d.y = s16(2560 - dropper);
    d.z = 0;
    d.oldShadow = 0;
    d.oldBall = 0;
    d.yadd = 0;
  }

  for (let a = 0; a < 500; a++) {
    const b = msRand() % DOTNUM;
    const c = msRand() % DOTNUM;
    let value = dots[b].x; dots[b].x = dots[c].x; dots[c].x = value;
    value = dots[b].y; dots[b].y = dots[c].y; dots[c].y = value;
    value = dots[b].z; dots[b].z = dots[c].z; dots[c].z = value;
  }
}

export function minvballReset() {
  if (!sin1024) throw new Error('loadMinvball() must complete before reset');

  rngState = 1;
  localTick = 0;
  fadeTick = 0;
  frame = 0;
  done = false;
  doneAtLocal = null;
  dropper = 22000;
  grav = 3;
  gravd = 13;
  gravitybottom = 8105;
  rot = 0;
  rots = 0;
  rota = -64;
  fctr = 0;
  // `j` is an uninitialized automatic in the released C/EXE. Its first value
  // depends on reused DOS stack memory, which the source does not define.
  // Zero is the deterministic intended reconstruction, not a claim that C
  // initialized it.
  dotCursor = 0;

  scrambleInitialState();
  buildPaletteAndBackground();

  // MAIN.C blacks the DAC before entering the 65-step fade (lines 148-151).
  pal2.fill(0);
  minvballPal.fill(0);
}

function restoreBytes(offset, count) {
  let p = u16(offset);
  for (let i = 0; i < count; i++, p = u16(p + 1)) {
    vgaSegment[p] = bgpic[p];
  }
}

function backgroundWord(offset) {
  const p = u16(offset);
  return bgpic[p] | (bgpic[u16(p + 1)] << 8);
}

function writeByte(offset, value) {
  vgaSegment[u16(offset)] = value;
}

function writeWord(offset, value) {
  writeByte(offset, value);
  writeByte(offset + 1, value >>> 8);
}

function writeDword(offset, value) {
  writeByte(offset, value);
  writeByte(offset + 1, value >>> 8);
  writeByte(offset + 2, value >>> 16);
  writeByte(offset + 3, value >>> 24);
}

function restoreBall(oldBall) {
  restoreBytes(oldBall, 4);
  restoreBytes(oldBall + 320, 4);
  restoreBytes(oldBall + 640, 4);
}

function drawOneDot(d, rotsin, rotcos) {
  const x = s16(d.x);
  const z = s16(d.z);

  // ASM.ASM:63-72.  The source's `mov ax,ax` and low-word `sub ax,bx`
  // look suspicious, but BP only receives DX: depth is exactly the difference
  // of the two signed product high words, plus 9000.
  const depthX = Math.imul(x, s16(rotsin)) >> 16;
  const depthZ = Math.imul(z, s16(rotcos)) >> 16;
  const bp = s16(depthZ - depthX + 9000);

  // ASM.ASM:74-94: (x*cos + z*sin) >> 8, multiplied by 9/8, signed-divided
  // by BP.  Bitwise operations deliberately preserve 386 32-bit wrapping.
  const rotated = (Math.imul(x, s16(rotcos)) + Math.imul(z, s16(rotsin))) | 0;
  const shifted = rotated >> 8;
  const widened = (shifted + (shifted >> 3)) | 0;
  const screenX = s16(idiv(widened, bp) + 160);

  // `cmp ax,319 / ja` is unsigned (ASM.ASM:95-96).
  if (u16(screenX) > 319) {
    // Literal @@2 path (ASM.ASM:185-202), including its odd assignment of
    // oldShadow from AX after restoring the third old-ball row.
    const oldBall = u16(d.oldBall);
    restoreBall(oldBall);
    const replacementShadow = backgroundWord(oldBall + 640);
    const oldShadow = u16(d.oldShadow);
    d.oldShadow = replacementShadow;
    restoreBytes(oldShadow, 2);
    return;
  }

  // ASM loads DX:AX with 0008:0000, not 0000:0200.  Thus the shadow is
  // projected with 524288/BP (ASM.ASM:100-118).
  const shadowY = s16(idiv(8 * 65536, bp) + 100);
  if (u16(shadowY) > 199) {
    const oldBall = u16(d.oldBall);
    restoreBall(oldBall);
    const replacementShadow = backgroundWord(oldBall + 640);
    const oldShadow = u16(d.oldShadow);
    d.oldShadow = replacementShadow;
    restoreBytes(oldShadow, 2);
    return;
  }

  const shadowPos = u16(shadowY * 320 + screenX);
  restoreBytes(d.oldShadow, 2);
  writeWord(shadowPos, 0x5757);
  d.oldShadow = shadowPos;

  // Gravity/bounce is inside drawdots and only runs after the dot passes both
  // horizontal and shadow clipping (ASM.ASM:120-136).
  d.yadd = s16(d.yadd + grav);
  let y = s16(d.y + d.yadd);
  if (y >= gravitybottom) {
    const negatedVelocity = s16(-d.yadd);
    const lowProduct = s16(Math.imul(negatedVelocity, gravd));
    d.yadd = s16(lowProduct >> 4);
    y = s16(y + d.yadd); // no clamp-to-bottom in the assembly
  }
  d.y = y;

  const screenY = s16(idiv(y << 6, bp) + 100);
  if (u16(screenY) > 199) {
    // @@3 restores the old ball but keeps the newly drawn shadow.
    restoreBall(d.oldBall);
    return;
  }

  const ballPos = u16(screenY * 320 + screenX);
  restoreBall(d.oldBall);

  // BP becomes a byte offset into the DD tables: (depth>>6)&~3, so the
  // actual Uint32 element is that offset / 4 (ASM.ASM:162-177).
  const depthIndex = ((u16(bp) >>> 6) & 0xfffc) >>> 2;
  writeWord(ballPos + 1, depthtable1[depthIndex]);
  writeDword(ballPos + 320, depthtable2[depthIndex]);
  writeWord(ballPos + 641, depthtable3[depthIndex]);
  d.oldBall = ballPos;
}

function drawdots(rotsin, rotcos) {
  // Do not clear from bgpic here.  The original restores each dot's saved
  // prior rectangles immediately before drawing it, preserving order-based
  // erasure/overlap artifacts (ASM.ASM:51-217).
  for (let i = 0; i < DOTNUM; i++) drawOneDot(dots[i], rotsin, rotcos);
}

function updateSpawnedDot() {
  frame = s16(frame + 1);
  if (frame === 500) fctr = 0;

  const i = dottaul[dotCursor];
  dotCursor = (dotCursor + 1) % DOTNUM;
  const d = dots[i];

  if (frame < 500) {
    d.x = s16(isin(fctr * 11) * 40);
    d.y = s16(icos(fctr * 13) * 10 - dropper);
    d.z = s16(isin(fctr * 17) * 40);
    d.yadd = 0;
  } else if (frame < 900) {
    d.x = s16(icos(fctr * 15) * 55);
    d.y = s16(dropper);
    d.z = s16(isin(fctr * 15) * 55);
    d.yadd = -260;
  } else if (frame < 1700) {
    const radius = idiv(sin1024[frame & 1023], 8);
    d.x = s16(icos(fctr * 66) * radius);
    d.y = 8000;
    d.z = s16(isin(fctr * 66) * radius);
    d.yadd = -300;
  } else if (frame < 2360) {
    d.x = s16(msRand() - 16384);
    d.y = s16(8000 - idiv(msRand(), 2));
    d.z = s16(msRand() - 16384);
    d.yadd = 0;
    if (frame > 1900 && !(frame & 31) && grav > 0) grav--;
  } else if (frame < 2400) {
    const amount = frame - 2360;
    for (let b = 0; b < 768; b += 3) {
      pal2[b] = Math.min(63, pal[b] + amount * 3);
      pal2[b + 1] = Math.min(63, pal[b + 1] + amount * 3);
      pal2[b + 2] = Math.min(63, pal[b + 2] + amount * 4);
    }
  } else if (frame < 2440) {
    const value = Math.max(0, 63 - (frame - 2400) * 2);
    pal2.fill(value);
  }

  if (dropper > 4000) dropper -= 100;

  // MAIN.C:271-279 computes factors for this draw before advancing `rot`.
  const drawRotcos = s16(icos(rot) * 64);
  const drawRotsin = s16(isin(rot) * 64);
  rots = s16(rots + 2);
  if (frame > 1900) {
    rot = s16(rot + idiv(rota, 64));
    rota = s16(rota - 1);
  } else {
    rot = isin(rots);
  }
  fctr = s16(fctr + 1);

  drawdots(drawRotsin, drawRotcos);
}

function stepStartupFade() {
  fadeTick++;
  // Each palette is installed after two dis_waitb() calls (MAIN.C:171-183).
  if (!(fadeTick & 1)) {
    const subtract = 65 - (fadeTick >>> 1); // tick 2 => 64, tick 130 => 0
    for (let i = 0; i < 768; i++) pal2[i] = Math.max(0, pal[i] - subtract);
    minvballPal.set(pal2);
  }
}

function finish() {
  done = true;
  doneAtLocal = localTick / VBLANK_HZ;
}

function stepMainFrame(musplusAtLocal) {
  // The source updates the DAC before its waitb repeat loop changes `frame`.
  // That one-frame lag is visible in the 2360..2440 flash/fade sequence.
  if (frame > 2300) minvballPal.set(pal2); // MAIN.C:188-190

  // dis_musplus is checked after waitb and before physics/drawing.  Evaluate it
  // during deterministic replay too; otherwise seeks skip the real transition.
  const musplus = musplusAtLocal ? musplusAtLocal(localTick / VBLANK_HZ) : -32;
  if (musplus > -4 && musplus < 0) {
    finish();
    return;
  } // MAIN.C:191-195

  updateSpawnedDot();
  if (frame >= LAST_MAIN_FRAME) finish();
}

export function minvballEnded() { return done; }
export function minvballLocalFrames() { return frame; }
export function minvballDurationS() {
  return doneAtLocal == null ? localTick / VBLANK_HZ : doneAtLocal;
}

export function minvballStepTo(tt, replay, musplusAtLocal) {
  if (done) return false;
  const targetTick = Math.max(0, Math.floor(tt * VBLANK_HZ));
  let steps = targetTick - localTick;
  if (steps <= 0) return true;
  if (steps > 35 && !replay) steps = 35;

  for (let i = 0; i < steps && !done; i++) {
    localTick++;
    if (fadeTick < STARTUP_FADE_TICKS) stepStartupFade();
    else stepMainFrame(musplusAtLocal);
  }
  return !done;
}
