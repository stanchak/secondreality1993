// Second Reality — MNTSCRL part engine, port of FOREST/READ2.PAS + BGR.PAS +
// AOS1/2/3.PAS + ROUTINES.ASM ("MNTSCRL.EXE" is FOREST's read2.exe renamed —
// see FOREST/X.BAT: `copy read2.exe ..\main\data\mntscrl.exe`, the same
// naming trick as PANICEND.EXE/PANIC/SD.EXE. Original source is public
// domain (Unlicense, 2013 anniversary release).
//
// The effect: a static picture (HILLBACK — moonlit tree branches over a
// glowing green mist) fades in, then a ghostly, wavy scrolltext ripples over
// it in place (no horizontal text motion on screen — the RIPPLE/distortion
// animates while the message crawls through a fixed on-screen window),
// finally the whole thing fades to black. The scrolling message, decoded
// from FOREST/O2.SCI (a RIX3-format 640x32 bitmap), reads "ANOTHER WAY TO
// SCROLL" — a title pun (this scrolltext's *rendering trick* is the joke,
// not its content).
//
// Mechanics (exact port of ROUTINES.ASM's `putrouts` + READ2.PAS's `scr`):
// HILLBACK is a plain 320x200 chunky (mode 0x13) picture, stored as its own
// RIX3 blob (4-byte magic + 2B width + 2B height + 2B unused + 768B 6-bit
// palette + 64000B pixel data) linked directly into the exe via
// BGR.PAS/`{$L hillback.obj}` — the same OMF-object-file trick as TECHNO's
// _CIRCLE.OBK (see techno.js's header), just for a single flat picture
// instead of a bit-plane bitmap; extractable straight from its LEDATA
// records (see assets/hillback.bin, a raw extract: 768B palette + 64000B
// pixels, header stripped). AOS1/AOS2/AOS3.PAS each link a POSn.obj/.DAT the
// same way — POS1/2/3.DAT (see assets/pos{1,2,3}.dat) are NOT pixel data but
// *remap tables*: for each of 237x31 = 7347 "font" cells (bx, row-major),
// a u16 element count followed by that many u16 destination byte-offsets
// into the 320x200 screen buffer. Three-quarters of the 7347 cells map to
// NOTHING (a genuinely sparse table, not a dense grid) — this is what turns
// a plain rectangular character cell into an irregular, curling "ghost
// writing" shape when rendered, and having 3 *different* tables (posi1/2/3)
// for the same logical font grid is what animates the ripple: the same
// content projected through 3 slightly different position maps in rotation.
//
// `font` (237 cols x 31 rows, byte per cell) holds a horizontally-scrolling
// window onto the message bitmap (`fbuf`, decoded from O2.SCI, tinted: any
// nonzero source pixel gets +128 mod 256 — see below for why). `scr(sss)`
// (called every vblank, sss cycling 0/1/2/0/1/2/...) does two things: it
// always calls `putrouts` using posi1/posi2/posi3 for sss=0/1/2 respectively
// (so 3 consecutive frames show the SAME font content through 3 different
// distortion maps — an animated wobble even when the text itself is
// momentarily still), and ONLY on sss===2 it scrolls `font` one column left
// and appends the next source column from `fbuf` (so the message itself
// advances one column every 3rd frame, ~23.3 cols/sec).
//
// `putrouts` (per destination pixel): `screen[di] = hillback[di] + font[bx]`
// with 8-bit wraparound — an INDEX-space addition, not a color blend. Where
// font[bx]==0 (no message content at this cell) this is a no-op (background
// shows through unchanged); where font[bx]!=0 (tinted to 128+something) it
// wraps the background's OWN palette index by a large offset, landing on a
// *different* palette entry — a context-sensitive hue-shift rather than a
// fixed overlay color, which is what gives the ghostly, semi-transparent
// look (see reference capture) instead of flat lettering.
//
// Palette choreography (setrgb calls in READ2.PAS) also does real work
// beyond a simple fade-in: indices 0-31 and 128-159 (64 of 256 slots —
// coincidentally, per HILLBACK's own palette, index 128 is pure black,
// suggesting these ranges were deliberately reserved/unused by the picture
// artwork's own palette) are EXCLUDED from the initial 64-vblank fade's own
// target from the start (`tmppal` has them pre-zeroed before the fade even
// begins, per source) — they stay black continuously from the initial hold
// straight through the fade, never brightening at all, and are only then
// PARTIALLY restored (indices 0-176, i.e. a 177-wide window covering both
// ranges) at HALF the frame rate (every other vblank) over the following
// 127-vblank "ripple intro" — so parts of the picture's own dark tones
// visibly swirl INTO view for the first time WHILE the ghost text is
// already rippling on top, compounding into the "swirling ghost cloud"
// look — see mntscrlReset()'s tmppal setup. Exact port of both
// palette ramps (fpal/tmppal, byte-for-byte increment/decrement).
//
// Timing (READ2.PAS only — the loader gate between PANICEND and MNTSCRL
// lives in MAIN/U2.ASM and is handled by main.js, NOT this module):
//   1. 64 vblank fade-in (indices 0-31/128-159 pre-zeroed in target)
//   2. busy-wait while dis_musplus()<0  (no vblank burn in source; we hold
//      the post-fade picture while music-local time advances)
//   3. 127 vblank ripple intro (`for y:=0 to 63*2` inclusive, partial palette restore + scr)
//   4. main loop until dis_musplus()==-11, then 64-vblank fade-out
//   5. veke=2800 is dead (inc(frame) is commented out) — exit is music only
//
// musplus values come from main.js (live tracker and/or s3msim lower bound).

const VBLANK_HZ = 70;
const trunc = (a, b) => (a / b) | 0;
const FONT_W = 237, FONT_H = 31, FONT_N = FONT_W * FONT_H;

// Source-exact fixed budgets (READ2.PAS). Music gates are NOT fixed frames.
const FADE1_FRAMES = 64;
const RIPPLE_INTRO_FRAMES = 127; // READ2.PAS `for y:=0 to 63*2` is INCLUSIVE: 127 iterations
const FADEOUT_FRAMES = 64;
// Safety cap if musplus==-11 never appears (sim/timeline short): ~60s main.
const MAIN_SAFETY_FRAMES = 70 * 60;

// --- assets ---
let bgPix = null;      // Uint8Array(320*200) -- HILLBACK picture, palette indices
let bgPal = null;      // Uint8Array(768) -- HILLBACK's own 6-bit palette
let fbuf = null;       // Uint8Array(31*640) -- O2.SCI scrolltext bitmap, tinted (+128 mod 256 where >0)
let posTables = null;  // [pos1, pos2, pos3], each: Array(FONT_N) of Uint16Array (dest offsets) or null

function parsePosTable(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cols = new Array(FONT_N);
  let off = 0;
  for (let bx = 0; bx < FONT_N; bx++) {
    const cnt = dv.getUint16(off, true); off += 2;
    if (cnt === 0) { cols[bx] = null; continue; }
    const dests = new Uint16Array(cnt);
    for (let i = 0; i < cnt; i++) { dests[i] = dv.getUint16(off, true); off += 2; }
    cols[bx] = dests;
  }
  return cols;
}

export async function loadMntscrl() {
  const [hbRes, sciRes, p1Res, p2Res, p3Res] = await Promise.all([
    fetch('assets/hillback.bin'), fetch('assets/mntscroll.sci'),
    fetch('assets/pos1.dat'), fetch('assets/pos2.dat'), fetch('assets/pos3.dat')]);
  const hb = new Uint8Array(await hbRes.arrayBuffer());
  bgPal = hb.slice(0, 768);
  bgPix = hb.slice(768, 768 + 320 * 200);

  const sci = new Uint8Array(await sciRes.arrayBuffer());
  // RIX3: 4B magic + u16 width + u16 height + u16 unused + 768B palette + pixels.
  // Only the message bitmap's pixels matter here (own palette unused -- the
  // message is drawn via index-arithmetic into HILLBACK's palette instead).
  const sciPix = sci.slice(10 + 768, 10 + 768 + 31 * 640);
  fbuf = new Uint8Array(31 * 640);
  for (let i = 0; i < fbuf.length; i++) fbuf[i] = sciPix[i] > 0 ? (sciPix[i] + 128) & 0xff : 0;

  posTables = await Promise.all([p1Res, p2Res, p3Res].map(async (r) =>
    parsePosTable(new Uint8Array(await r.arrayBuffer()))));
  console.log('[MNTSCRL] hillback picture + scrolltext + 3 ripple maps loaded');
}

export const mntscrlVram = new Uint8Array(320 * 200);
export const mntscrlPal = new Uint8Array(768);

// partLocalFrame: music-local 1/70s ticks since part start (includes gate hold).
// phase: fade1 -> gate -> ripple -> main -> fadeout -> done
let partLocalFrame = -1;
let phase = 'fade1';
let phaseFrame = 0;
let mainFrames = 0;
let lastMusplus = -32;   // for detecting skipped ==-11 under catch-up
let doneAtLocal = null;
let font = null;       // Uint8Array(FONT_N)
let scp = 0;            // next unread column of fbuf's 640-wide message
let sss = 0;             // 0/1/2, cycles every vblank once rendering starts
let fpal = null, tmppal = null;   // Uint8Array(768) each, animated/target palette

export function mntscrlEnded() { return phase === 'done'; }
export function mntscrlLocalFrames() { return partLocalFrame; }
export function mntscrlDurationS() {
  if (doneAtLocal != null) return doneAtLocal;
  return Math.max(0, partLocalFrame) / VBLANK_HZ;
}

export function mntscrlReset() {
  partLocalFrame = -1;
  phase = 'fade1';
  phaseFrame = 0;
  mainFrames = 0;
  lastMusplus = -32;
  doneAtLocal = null;
  font = new Uint8Array(FONT_N);
  for (let row = 0; row < FONT_H; row++)
    for (let i = 0; i < 133; i++) font[row * FONT_W + 104 + i] = fbuf[row * 640 + i];
  scp = 133;
  sss = 0;
  fpal = new Uint8Array(768);
  // READ2.PAS's first fade targets `pal` with indices 0-31/128-159 ALREADY
  // zeroed (`move(pal,tmppal,768); fillchar(tmppal,32*3,#0);
  // fillchar(tmppal[128*3],32*3,#0);`) -- those ranges never light up during
  // this first fade at all.
  tmppal = bgPal.slice();
  tmppal.fill(0, 0, 32 * 3);
  tmppal.fill(0, 128 * 3, 160 * 3);
  mntscrlVram.set(bgPix);
  mntscrlPal.fill(0);
}

function putrouts(sssIdx) {
  // NOTE: a listed destination is rewritten every frame REGARDLESS of
  // whether font[bx] is currently 0 -- when it is, this is bg[di]+0=bg[di],
  // an explicit reset back to the background pixel. Skipping the fval===0
  // case (as an "optimization") would leave stale ghost pixels behind as
  // the message scrolls past a cell, since nothing else ever repaints them.
  const table = posTables[sssIdx];
  for (let bx = 0; bx < FONT_N; bx++) {
    const dests = table[bx];
    if (!dests) continue;
    const fval = font[bx];
    for (let i = 0; i < dests.length; i++) {
      const di = dests[i];
      mntscrlVram[di] = (bgPix[di] + fval) & 0xff;
    }
  }
}

function scr(sssIdx) {
  putrouts(sssIdx);
  if (sssIdx === 2) {
    for (let row = 0; row < FONT_H; row++) {
      const base = row * FONT_W;
      font.copyWithin(base, base + 1, base + FONT_W);
      font[base + FONT_W - 1] = scp < 640 ? fbuf[row * 640 + scp] : 0;
    }
    if (scp < 639) scp++;
  }
}

function rampToward(pal, target, lo, hi) {
  for (let i = lo; i < hi; i++) if (pal[i] < target[i]) pal[i]++;
}
function rampAway(pal, target, lo, hi) {
  for (let i = lo; i < hi; i++) if (pal[i] > target[i]) pal[i]--;
}

// Advance one music-local 1/70s tick. musplusAtLocal(localS) returns dis_musplus()
// at part-local seconds (0 = READ2 start, after the loader gate).
function stepOneLocalTick(musplusAtLocal) {
  partLocalFrame++;
  const localS = partLocalFrame / VBLANK_HZ;
  const getM = musplusAtLocal || (() => -32);

  if (phase === 'fade1') {
    rampToward(fpal, tmppal, 0, 768);
    phaseFrame++;
    if (phaseFrame >= FADE1_FRAMES) {
      // Source: fpal:=pal with 0-31/128-159 zeroed (already true after ramp);
      // tmppal becomes full bgPal for the ripple-intro partial restore.
      tmppal.set(bgPal);
      phase = 'gate';
      phaseFrame = 0;
    }
    return;
  }

  if (phase === 'gate') {
    // READ2.PAS busy-wait: while musplus < 0 (no waitr inside). Hold picture.
    if (getM(localS) >= 0) {
      phase = 'ripple';
      phaseFrame = 0;
      sss = 0;
    }
    return;
  }

  if (phase === 'ripple') {
    if ((phaseFrame & 1) === 1) rampToward(fpal, tmppal, 0, 177 * 3);
    scr(sss);
    sss = sss === 2 ? 0 : sss + 1;
    phaseFrame++;
    if (phaseFrame >= RIPPLE_INTRO_FRAMES) {
      tmppal.fill(0);   // fade-OUT target for the eventual exit
      phase = 'main';
      phaseFrame = 0;
      mainFrames = 0;
    }
    return;
  }

  if (phase === 'main') {
    // if musplus == -11: start fadeout (READ2.PAS). Also catch a skipped
    // exact -11 when catch-up jumps multiple rows in one tick.
    const m = getM(localS);
    // Exact -11 (READ2.PAS), or a catch-up skip across -11 while already in the
    // "marker coming" ramp (musplus = row-64 ∈ (-32,-11]). Do NOT treat a jump
    // from far (-32) to post-marker positive as an exit — that was a false hit.
    const crossed =
      lastMusplus > -32 && lastMusplus <= -11 && m > -11 && m < 16;
    const hitExit = m === -11 || crossed || mainFrames >= MAIN_SAFETY_FRAMES;
    lastMusplus = m;
    if (hitExit) {
      phase = 'fadeout';
      phaseFrame = 0;
    } else {
      scr(sss);
      sss = sss === 2 ? 0 : sss + 1;
      mainFrames++;
    }
    return;
  }

  if (phase === 'fadeout') {
    rampAway(fpal, tmppal, 0, 768);
    scr(sss);
    sss = sss === 2 ? 0 : sss + 1;
    phaseFrame++;
    if (phaseFrame >= FADEOUT_FRAMES) {
      phase = 'done';
      doneAtLocal = (partLocalFrame + 1) / VBLANK_HZ;
    }
  }
}

function drawFrame() {
  mntscrlPal.set(fpal);
}

// tt = seconds since MNTSCRL part start (after loader gate). musplusAtLocal(s)
// is dis_musplus at that part-local time (required for correct gate/exit).
export function mntscrlStepTo(tt, replay, musplusAtLocal) {
  if (phase === 'done') return false;
  const target = Math.floor(tt * VBLANK_HZ);
  let steps = target - partLocalFrame;
  if (steps <= 0) { drawFrame(); return true; }
  if (steps > 35 && !replay) steps = 35;
  for (let s = 0; s < steps && phase !== 'done'; s++) stepOneLocalTick(musplusAtLocal);
  drawFrame();
  return phase !== 'done';
}
