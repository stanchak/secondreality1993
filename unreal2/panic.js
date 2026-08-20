// PANICEND — port of PANIC/SHUTDOWN.C + TWEAK.ASM + ASMYT.ASM. The shipped
// PANICEND.EXE is a renamed copy of PANIC/SD.EXE (see PANIC/X.BAT), which is why
// no source directory matches the part name.
//
// Runs immediately after TECHNO's troll-picture hold, per the loader's own call
// chain in MAIN/U2.ASM: exe6=TECHNO, exe7=PANICEND, then a dis_musplus() wait
// gate, then exe9=MNTSCRL. The whole gag lasts about 2.7 seconds.
//
// It is a CRT power-off: the picture crushes to a thin horizontal line, the line
// shrinks to a point, and the point fades. The shipped _LOADER_ build crushes
// whatever TECHNO left on screen — its troll endcard and its DAC — rather than
// loading a picture of its own; there is no monster.u in MAIN/PACKFINA.INC.
// panicReset(technoVram400, technoPal) hands that inherited state over, and
// standalone monster mode remains available for reference.
//
// GEOMETRY. tw_opengraph builds a 640x400 canvas at a 160-byte pitch and stages
// the picture into columns 320..639; CRTC start-address pokes pan which 320-wide
// window is displayed. copyline() (ASMYT.ASM) is a VGA latch-transfer block copy
// and it is LINEAR — it does not respect row boundaries, so a copy starting at
// pixel column 320 spills into the following row. That is how the crush samples
// full-detail rows out of the staging copy rather than a pre-squished one.
// Modelled here as a flat 640x400 array with linear block copies, which
// sidesteps planes and latches entirely.
//
// DISPLAY. SHUTDOWN.C pokes CRTC reg 9 = 0x41 after its first dis_waitb, so from
// that frame every logical row is scan-doubled; one frame later it doubles the
// pitch to 320 bytes. The visible raster is therefore canvas rows 0,2,4..398,
// each shown twice. Every crush write lands on an even canvas row because C's
// `(b-a/2)*320` uses integer a/2 — translating that as `2*b-a` would put odd
// iterations on rows that are never displayed.
//
// Register timing is modelled per frame: DAC writes, reg 9 and the pitch
// register take effect immediately, and only tw_setstart is latched at the
// following vblank. Both reduce to "apply each waitb-interval's writes at that
// frame's start", because every tw_setstart here is issued just before a
// dis_waitb.

const VBLANK_HZ = 70;
const trunc = (a, b) => (a / b) | 0;

// --- fixed frame budget (no music gate inside SHUTDOWN.C itself) ---
// MONSTER_HOLD_FRAMES: how long the face is shown before the crush begins.
// Source-derived: main()'s picture-decode/draw work makes no dis_waitb() call
// before shutdown()'s first one, and shutdown() does its blacken/squish/setstart
// setup before its own first dis_waitb() too — so there is no deliberate hold at
// all. One frame, the minimum needed to render the face before transitioning.
// The gag is a single-frame flash rather than a lingering shot, which suits the
// source's own name for it ("Panicfake").
const MONSTER_HOLD_FRAMES = 1;
// Frame f displays the interval after SHUTDOWN.C's f-th dis_waitb (f=0 is
// everything before the first one — the monster face itself):
//   f=1: reg9 doubled + start 16000 + fadepals[3] + index-0 forced WHITE
//        (SHUTDOWN.C:67-82) -> "photo negative" flash: the half-height squish
//        copy (canvas rows 150-249, doubled back to 200 scanlines) on white.
//   f=2: start 0 + pitch 320 + fadepals[20] (C:84-89) -> quarter-height
//        squish centered on black.
//   f=3: the crush for-loop's OWN first dis_waitb (C:93) runs before any
//        copylines, so this frame is an exact static repeat of f=2.
const NEGATIVE_FLASH_FRAME = MONSTER_HOLD_FRAMES;
const SQUISH_CENTER_FRAME = NEGATIVE_FLASH_FRAME + 1;
// crush loop: `for(a=32;a>2;a=a*5/6)` -> a = 32,26,21,17,14,11,9,7,5,4,3 (11 outer iters, 1 vblank each)
const CRUSH_A_VALUES = (() => {
  const vs = []; let a = 32;
  while (a > 2) { vs.push(a); a = trunc(a * 5, 6); }
  return vs;
})();
const CRUSH_START = SQUISH_CENTER_FRAME + 2;                    // f=4..14
const CRUSH_END = CRUSH_START + CRUSH_A_VALUES.length - 1;
// horizontal shrink: `for(x=20;x<=160;x+=3)` -> 47 steps, 1 vblank each (f=15..61)
const HSHRINK_X_VALUES = (() => {
  const vs = []; for (let x = 20; x <= 160; x += 3) vs.push(x); return vs;
})();
const HSHRINK_END = CRUSH_END + HSHRINK_X_VALUES.length;
// dot fade: `for(a=0;a<60;a++)` -> 60 vblanks (f=62..121)
const DOTFADE_END = HSHRINK_END + 60;
// `sleep(1)`: a genuine ~1 real second pause before the next part loads.
// +1: frame index PANIC_END itself is also stepped (a terminal held frame),
// keeping the total at the source-derived 192-frame budget main.js relies on
// (PANIC_END_FRAMES) — 122 waitb intervals + ~70 frames of sleep(1).
const HOLD_FRAMES = 70;
const PANIC_END = DOTFADE_END + HOLD_FRAMES + 1;

// --- 640x400 flat pixel canvas (see header: linear-address copies, no planes) ---
const CW = 640, CH = 400;
let buf = null;              // Uint8Array(CW*CH)
let monsterPix = null;       // Uint8Array(320*200), the source picture (buf is mutated destructively)
let monsterPal = null;       // Uint8Array(768), 6-bit
let fadepals = null;         // [64][768] 6-bit, base palette (a=0) -> white (a=63); rebuilt per reset

function put(x, y, c) { if (x >= 0 && x < CW && y >= 0 && y < CH) buf[y * CW + x] = c; }
function get(x, y) { return (x >= 0 && x < CW && y >= 0 && y < CH) ? buf[y * CW + x] : 0; }
function addr(row, xbyte) { return row * CW + xbyte * 4; }
function copyline640(fromAddr, toAddr) { buf.copyWithin(toAddr, fromAddr, fromAddr + 640); }

export const panicVram = new Uint8Array(320 * 400);
export const panicPal = new Uint8Array(768);

export async function loadPanic() {
  const res = await fetch('assets/monster.bin');
  const raw = new Uint8Array(await res.arrayBuffer());
  monsterPal = raw.slice(0, 768);
  monsterPix = raw.slice(768, 768 + 320 * 200);
  buf = new Uint8Array(CW * CH);
  console.log('[PANIC] monster picture loaded (standalone-build fallback content)');
}

// fadepals interpolate the ACTIVE base palette toward white — in the shipped
// _LOADER_ build that base is getpal()'s snapshot of whatever DAC the
// previous part left (SHUTDOWN.C:52), so the tables must be rebuilt at reset
// time from the mode's base palette, not precomputed from monster.bin.
function buildFadepals(basePal) {
  fadepals = [];
  for (let a = 0; a < 64; a++) {
    // source's fade loop starts at b=3 (SHUTDOWN.C:62), leaving color index
    // 0's RGB (bytes 0-2) at C's zero-initialized default -- i.e. black --
    // in every fadepals[a]. The one-time tw_setrgbpalette(0,63,63,63) right
    // after fadepals[3] loads is the ONLY place index 0 is ever white; every
    // later tw_setpalette(fadepals[N]) call silently reverts it back to
    // black. Computing index 0 here (as if it faded like every other color)
    // would keep the background white for the whole crush, not just 1 frame.
    const fp = new Uint8Array(768);
    for (let b = 3; b < 768; b++) fp[b] = trunc(a * 63 + basePal[b] * (64 - a), 64);
    fadepals.push(fp);
  }
}

let frame = -1;
let crtcStartByte = 0, crtcStrideBytes = 160;
let crtcDoubled = false;   // CRTC reg 9 = 0x41 (max scan line 1): each logical row on 2 scanlines
let curPal = null;   // Uint8Array(768) currently displayed palette

export function panicEnded() { return frame >= PANIC_END; }
export function panicEndFrames() { return PANIC_END; }
export function panicLocalFrames() { return frame; }

// panicReset(inheritVram400, inheritPal): shipped _LOADER_ behavior — the gag
// runs on the INHERITED screen (the previous part's parting 320x400 frame,
// e.g. TECHNO's troll endcard) and the inherited DAC. The inherited display
// buffer maps 1:1 onto canvas right-half rows 0-399: that is exactly the
// layout shutdown()'s geometry assumes (picture staged in columns 320-639,
// shown through the start=80 window), so frame 0 here is pixel-identical to
// the previous part's last frame — a seamless hardware-truthful handoff.
// panicReset() with no arguments: standalone SD.EXE behavior — monster.bin
// drawn row-doubled into the right half (SHUTDOWN.C:45-49).
// Either way the canvas is rebuilt fresh: the crush mutates it destructively,
// so a replay needs the content restaged from scratch.
export function panicReset(inheritVram400 = null, inheritPal = null) {
  frame = -1;
  const inherited = !!(inheritVram400 && inheritPal);
  const basePal = inherited ? inheritPal : monsterPal;
  buf.fill(0);
  if (inherited) {
    for (let y = 0; y < 400; y++) {
      buf.set(inheritVram400.subarray(y * 320, (y + 1) * 320), y * CW + 320);
    }
  } else {
    for (let y = 0; y < 200; y++) {
      for (let x = 0; x < 320; x++) {
        const c = monsterPix[y * 320 + x];
        buf[(y * 2) * CW + (x + 320)] = c;
        buf[(y * 2 + 1) * CW + (x + 320)] = c;
      }
    }
  }
  // _LOADER_'s getpal() DAC snapshot -> fade tables (SHUTDOWN.C:52 + 62)
  buildFadepals(basePal);
  crtcStartByte = 80; crtcStrideBytes = 160; crtcDoubled = false;
  curPal = Uint8Array.from(basePal);
  panicVram.fill(0); panicPal.fill(0);
}

function stepOneFrame() {
  frame++;
  if (frame === NEGATIVE_FLASH_FRAME) {
    // SHUTDOWN.C:61-64 (composed during the face frame's CPU time, into
    // regions the start=80 window never shows): blacken row 0's left half —
    // it becomes the "black source line" every crush erase copies from —
    // and build the squished half-height copy at rows 150-249.
    for (let a = 0; a < 320; a++) put(a, 0, 0);
    for (let y = 0; y < 100; y++) for (let x = 0; x < 320; x++) put(x, y + 150, get(x + 320, y * 4));
    crtcStartByte = 100 * 160;   // tw_setstart(100*160), C:65 — latched at this vblank
    crtcDoubled = true;          // reg 9 = 0x41, C:67-71 — immediate, doubles this whole frame
    // tw_setpalette(fadepals[3]) + tw_setrgbpalette(0,63,63,63), C:80-81:
    // the ONLY frame where color index 0 (the blackened background) is white
    // -- every later full-palette load reverts it back to black (see
    // loadPanic()'s comment), just like source.
    curPal = fadepals[3].slice(); curPal[0] = 63; curPal[1] = 63; curPal[2] = 63;
  } else if (frame === SQUISH_CENTER_FRAME) {
    crtcStartByte = 0;           // tw_setstart(0), C:82 — latched at this vblank
    crtcStrideBytes = 320;       // reg 0x13 = 0xA0, C:85-89 — even canvas rows only from here on
    curPal = fadepals[20].slice();
  } // SQUISH_CENTER_FRAME+1: static repeat (crush loop's own first dis_waitb, C:93)
  else if (frame >= CRUSH_START && frame <= CRUSH_END) {
    const i = frame - CRUSH_START;
    const a = CRUSH_A_VALUES[i];
    curPal = fadepals[63 - a].slice();
    for (let b = a >> 1; b <= a; b++) {
      copyline640(addr(0, 0), addr(200 - 2 * b, 0));
      copyline640(addr(0, 0), addr(200 + 2 * b, 0));
    }
    for (let b = 0; b < a; b++) {
      const srcRow = trunc(400 * b, a);
      // C:101: dest byte 200*160+(b-a/2)*320 with INTEGER a/2 — i.e. row
      // 200 + 2*(b - trunc(a/2)), always an EVEN (displayed) row. The
      // earlier `200 + 2*b - a` translation put every odd-`a` iteration on
      // odd rows, which the even-rows-only raster never shows.
      copyline640(addr(srcRow, 80), addr(200 + 2 * (b - (a >> 1)), 0));
    }
    if (frame === CRUSH_END) {
      copyline640(addr(0, 0), addr(202, 0));
      copyline640(addr(0, 0), addr(198, 0));
    }
  } else if (frame > CRUSH_END && frame <= HSHRINK_END) {
    const i = frame - CRUSH_END - 1;
    const x = HSHRINK_X_VALUES[i];
    put(x, 200, 0); put(320 - x, 200, 0);
    put(x + 1, 200, 0); put(319 - x, 200, 0);
    put(x + 2, 200, 0); put(318 - x, 200, 0);
    put(x + 3, 200, 0); put(317 - x, 200, 0);
    if (i === HSHRINK_X_VALUES.length - 1) put(160, 200, 1);
  } else if (frame > HSHRINK_END && frame <= DOTFADE_END) {
    const a2 = (frame - HSHRINK_END - 1) * 1;   // `for(a=0;a<60;a++)`, 1 vblank/step
    // C:133 assigns the double to an int -> TRUNCATION toward zero, not rounding
    const b = (Math.cos(a2 / 120.0 * 3 * 2 * Math.PI) * 31.0 + 32) | 0;
    curPal = curPal.slice();
    curPal[1 * 3 + 0] = b; curPal[1 * 3 + 1] = b; curPal[1 * 3 + 2] = b;
  }
  // else: HOLD_FRAMES tail -- screen sits on whatever the dot-fade left it at
}

function drawFrame() {
  // CRTC fetch model: output scanline oy fetches 80 bytes (320 px) starting
  // at start + charRow*pitch, where charRow advances every scanline with
  // reg 9 = 0 and every OTHER scanline once reg 9 = 0x41 (crtcDoubled).
  // Flat-pixel space: byte address b <-> pixels b*4..b*4+3 (plane = px & 3),
  // so an 80-byte fetch is 320 consecutive flat pixels. The 16-bit CRTC
  // address wrap never triggers with this part's start/pitch values (max
  // fetch byte is 63759), but mask anyway to match hardware.
  for (let oy = 0; oy < 400; oy++) {
    const charRow = crtcDoubled ? (oy >> 1) : oy;
    const byteAddr = (crtcStartByte + charRow * crtcStrideBytes) & 0xffff;
    let src = byteAddr * 4;
    const rowOut = oy * 320;
    for (let ox = 0; ox < 320; ox++, src++) {
      panicVram[rowOut + ox] = src < CW * CH ? buf[src] : 0;
    }
  }
  panicPal.set(curPal);
}

export function panicStepTo(tt, replay) {
  if (frame >= PANIC_END) return false;
  const target = Math.min(PANIC_END, Math.floor(tt * VBLANK_HZ));
  let steps = target - frame;
  if (steps <= 0) return true;
  if (steps > 35 && !replay) steps = 35;
  for (let s = 0; s < steps && frame < PANIC_END; s++) stepOneFrame();
  drawFrame();
  return frame < PANIC_END;
}
