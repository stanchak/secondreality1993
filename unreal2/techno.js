// TECHNO — port of TECHNO/KOE.C + KOEA.ASM + KOEB.ASM (Psi). Runs on MUSIC1,
// immediately after TUNNELI with no gap.
//
// koe.c's main() runs five phases:
//
//  1. dointerference2 (KOEB) — 256 vblanks. Its sprite blit is dead code
//     (`jmp @@OVER3`), so only the DAC animates: a cyan pulse fading up from
//     black over the static ring canvas.
//
//  2. dointerference (KOEA) — the wobbling, palette-cycling ring blob.
//     _CIRCLE.OBK/_CIRCLE2.OBK are OMF object files linked into koe.exe (see
//     MAKEFILE): raw 1bpp bitmaps in their LEDATA records, extracted to
//     assets/circle1.bin and circle2.bin. init_interference 4-way-mirrors each
//     into a 640x400 canvas and captures its rotated ring buffer from plane 2
//     BETWEEN the two blits, so _circle2 becomes the animated foreground and
//     _circle's three planes the static background. Foreground bit<<3 plus the
//     static 0..7 gives the final 0..15 DAC index. The original's 8-copy
//     bit-rotation buffer existed only to sub-pixel-shift a bit-packed VGA
//     buffer; sampling the decoded array directly is equivalent.
//
//  3. A 4-vblank white flash, then koe.c's `for(b=0;b<4;b++)` growing-bars wipe.
//     Each bar grows on a fixed 21-vblank curve, then the code waits for
//     `dis_musrow()&7==7` before flashing white and starting the next — so the
//     bars land on the beat. stepWedge polls the real engine for that, exactly
//     as the original polled DIS.
//
//  4. doit1/doit2/doit3 — 11 nested rectangle outlines, XOR-outlined then
//     even-odd filled. The original draws into one bit-plane of one of 8
//     off-screen pages and displays it immediately; that page's other three
//     planes still hold what it held 8/16/24 frames ago, so the visible pixel is
//     the sum of four time-staggered snapshots — a free multi-exposure glow.
//     Reproduced by summing the fills of frames N, N-8, N-16 and N-24. doit3
//     then orbits the box and pans it off screen.
//
//  5. Mode reset, then the TROLL picture (PANICPIC.LBM, 320x400) wipes in on the
//     CRTC start address, ripples, and holds.
//
// TIMING. The gates are music positions, not frame counts:
//     prewait      while(dis_musplus() < -4)   before phase 1
//     pre-wedge    while(dis_musplus() < -3)   before the bars
//     wedge beats  dis_musrow() & 7 == 7
//     doit3 exit   order>35 || (order==35 && row>48)   — MUSIC1-abs 108.231s
// currentRow() prefers the live engine row (chip.row, passed in by main.js)
// during real playback and falls back to simRowAt() only for catch-up frames and
// ?silent mode, where no live value exists.
//
// WOBBLE_END is measured rather than derived: phase 2 exits on a
// dis_getmframe() threshold, and mframe is interrupt-fed, so it under-counts
// under this phase's per-pixel load. See the constant for the measurement.

const VBLANK_HZ = 70;
const trunc = (a, b) => (a / b) | 0;   // C integer division (truncates toward 0)

// MUSIC1 holds speed=3/tempo=130 through this whole part -> rows advance at
// a constant tempo/(speed*2.5) = 17.3333/s. dis_musrow()&7==7 (the
// waitborder()/do_interference() beat-flash trigger, and the wedge's
// beat-sync gate) is exactly periodic in ELAPSED TIME.
//
// GROUND TRUTH: the ORIGINAL demo's dis_musrow() queried the REAL playing
// tracker engine directly (a live DIS interrupt call), not a precomputed
// timestamp. This port has the equivalent available: chiptune3.js's
// libopenmpt worklet already calls openmpt_module_get_current_row() every
// audio block and exposes it as chip.row (see main.js, which passes it into
// technoStepTo's 3rd argument as `liveRow`). currentRow() below prefers
// this live value whenever it's available (real, non-silent playback);
// simRowAt() is used ONLY as the necessary fallback for (a) catch-up/replay
// frames, where no historical live value exists — only the current
// snapshot — and (b) ?silent verification/test mode, which has no real
// audio engine running at all.
//
// simRowAt() itself is a from-source-simulated row clock (MUSIC1's actual
// row/order/speed/tempo sequence, descrambled S3M, same simulator used for
// the doit3-exit gate elsewhere in this file) — it exists to make replay/
// silent-mode behavior as close to correct as possible even without live
// data, not as the primary timing source. Two things had to be right for it
// to even approximate the truth: MUSIC1 has been playing continuously since
// GLENZ_START, long before TECHNO starts, so "row" is NOT 0 at TECHNO's own
// frame 0 — the true row there is 60, and
// TECHNO_START itself lands 57.33% of the way INTO that row's own window
// (row 60 starts at music1-elapsed 59.076923s, one row lasts
// speed*2.5/tempo = 0.0576923s), so the correct anchor is the FRACTIONAL
// value 60.57333, not the bare integer 60. The one pattern break inside
// TECHNO's ~53s span (order_idx=26, row 31 -> next order row 0, a C00 at
// music1-elapsed 83.02s) breaks after exactly 32 rows (a multiple of 8), so
// it doesn't disturb the row&7 phase — a simple continuous elapsed-rows
// counter, anchored at that one precise start value, stays a reasonable
// approximation for TECHNO's whole duration.
const ROWS_PER_FRAME = 130 / (3 * 2.5 * VBLANK_HZ);
const ROW_AT_TECHNO_START = 60.5733333333462;
const simRowAt = f => Math.floor(ROW_AT_TECHNO_START + f * ROWS_PER_FRAME);

let liveRow = null;   // chip.row from main.js, or null (silent mode / not yet available)
function currentRow(f, useLive) { return (useLive && liveRow != null) ? liveRow : simRowAt(f); }

// --- phase frame boundaries (cumulative vblanks since TECHNO's part start) ---
// koe.c's main() actually opens with `while(!dis_exit() && dis_musplus()<-4);`
// — a real BLOCKING wait on a music-position gate — before dointerference2()
// is even called. Its DURATION was measured directly against the reference
// capture: tunnel's last visible content in the capture is at video-time
// ~168.1, but its TRUE (source-derived, VEKE=1060) demo-time end is 167.313
// — giving a video-lags-audio drift of ~0.79s at this point in the timeline
// (consistent in direction, if not magnitude, with the project's established
// capture drift). The capture's first perceptible ring content is at video
// ~168.8, i.e. demo-time ~168.01 after correcting for that drift — a ~0.70s
// gap after the tunnel's true end. 49 frames (0.70s) of solid black precedes
// IF2_END below to match (confirmed by a matched frame-by-frame comparison
// against the capture at identical relative timestamps).
//
// The real `dis_musplus()` is DIS/DISINT.ASM, built with INDEMO=1 by the demo
// kernel (MAIN/U2.ASM) — not the standalone DIS/DIS.ASM stub — and s3msim.js
// derives the music gates from it. It does NOT pin this specific constant: a
// musplus lower bound comes out at only ~2 frames, wildly under 49, and —
// unlike HOLD_END below — there's no hard
// budget cap here to make that lower bound decisive, and no existing
// measurement it's consistent with. The gap traces to a genuine, source-
// unresolvable ambiguity: `dis_musplus()`'s ramp only activates once STMIK's
// internal `np_zplus` flag flips, and exactly when that happens within an
// order isn't recoverable (it's inside STMIK.300, a precompiled library with
// no shipped source) — see s3msim.js's header for the full derivation this
// was checked against (GLENZ's already-validated gates, which the simulator
// reproduces exactly). Keeping the video measurement as authoritative here.
const PREWAIT_FRAMES = 49;
const IF2_END = PREWAIT_FRAMES + 256;     // dointerference2 (KOEB): fixed 256-vblank local framecount exit
// dointerference's (KOEA's do_interference) exit is NOT a fixed budget:
// koe.c calls dis_setmframe(0) exactly once, right before dointerference2
// runs — and dointerference2 (KOEB) itself exits via its OWN local
// framecount reaching 256, as above. dointerference (KOEA), though, checks
// the GLOBAL dis_getmframe() against 925 instead of its own locally-
// incremented framecount — the obvious `cmp framecount,70*13` (910) check
// is present in KOEA.ASM but literally commented out, replaced by the
// active `mov ax,0; mov bx,9; int 0fch; cmp ax,925; jae @@xx` a few lines
// below it (found by reading past the commented-out check to what actually
// replaced it).
//
// That source reading is correct about WHAT the check says, but it's wrong
// to assume `mframe` ticks in lockstep with a clean 70Hz frame clock the way
// this port's own VBLANK_HZ does. `mframe` is a real global vblank counter,
// but dointerference (KOEA) does real per-pixel work across a 640x400
// mirrored canvas every frame — the kind of workload 1993 hardware plausibly
// couldn't render at a full sustained 70fps — while dointerference2 (KOEB)
// is nearly free (its sprite-blit is dead code; only DAC writes happen).
// If the original ran dointerference below 70fps, each `mframe` tick took
// MORE than 1/70s of real wall-clock time during just this phase, so
// "669 vblanks" is not "669/70 real seconds" the way it is everywhere else
// in this file. A direct measurement of the reference capture (motion/
// texture signal analysis, not eyeballing) confirmed this:
// the real on-screen duration of dointerference (its hard-cut white-flash-
// out to the next hard-cut white-flash-in) is ~987 vblanks-at-70Hz (14.1s),
// not 669 (9.56s). Using the measured value instead of the mframe-derived one.
const WOBBLE_END = IF2_END + 987;

// koe.c also has a second real gate, `while(dis_musplus()<-3);` (KOE.C:275),
// right here before the wedge's own beat-wait begins. Deliberately left
// unmodeled: a musplus() lower bound gives only a ~2-frame estimate
// (same activation-timing ambiguity as PREWAIT_FRAMES above), there's no
// existing measurement or hard budget cap to make that decisive, and it was
// already low-priority — live playback self-corrects regardless, since the
// wedge that immediately follows gates on the real engine's beat, not a
// fixed offset from here.

// --- wedge sequence: live beat-synchronized state machine ------------------
// koe.c's zly/zya recurrence for the growing-bar reveal (21 fixed vblanks):
//   zy=0,zya=0; for(a=256;a>-400;a-=32){ zly=zy; zya++; zy+=zya; ...reveal... }
// Colors: while a>=0, flash(a) blends the bar's DAC entry from white (a=256)
// down to black (a=0); once a goes negative, flash(0) is a no-op repaint (the
// bar just holds black) — so each bar briefly flashes white then settles black
// as it grows, over the SAME 21 steps regardless of beat position.
const WEDGE_GROWTH = (() => {
  const steps = []; let zy = 0, zya = 0;
  for (let a = 256; a > -400; a -= 32) { const zly = zy; zya++; zy += zya; steps.push({ a, zly, zy: Math.min(zy, 200) }); }
  return steps;
})();
// Per-vblank state machine, stepped live (see stepWedge below): initial wait
// for the first beat (screen holds whatever the mode-tweak setup left it at
// — solid background, no bars grown yet), then 4x { 21-step shrink, wait for
// next beat (screen holds the fully-grown black bar), 4-step flash-to-white
// }. Each wait checks currentRow()&7==7 directly against the LIVE music
// engine during real playback (see currentRow's derivation comment above),
// falling back to the simulated clock only for replay/silent-mode frames.
// Since the wedge's real-world duration now depends on live timing and
// isn't knowable in advance, DOIT1_END/DOIT2_END/etc. below are no longer
// compile-time constants — they're set once, dynamically, the moment the
// wedge actually finishes (see stepWedge's wedgeBar>=4 branch).
let wedgeBar = 0, wedgeSub = 'prewait', wedgeStep = 0, wedgeDone = false;
let DOIT1_END = Infinity, DOIT2_END = Infinity, DOIT3_BOX_END = Infinity;
// koe.c's wipe-in loop (count budget 300) breaks the instant xpos reaches
// 320 — same accelerating integer ramp as doit3's wipeout, so it finishes in
// ~53 frames, not the full nominal budget (exact integer simulation).
//
// HOLD_END's own exit (KOE.C:705-709) is a REAL music-position gate too:
// `count=420;xpos=320; while(...){ a=dis_musplus(); if(a>-6&&a<16) break;
// ...count-=dis_waitb(); }` — a musplus() gate with a 420-vblank hard budget
// cap. Derived via s3msim.js: musplus() depends on STMIK's internal
// `np_zplus` flag, whose exact activation timing within an order isn't
// recoverable from source (it's inside STMIK.300, a precompiled library
// with no shipped source) — so any source-only estimate of WHEN this gate
// fires is only a LOWER BOUND (earliest-possible activation; a later
// activation only ever delays the ramp). That lower bound, computed from a
// nominal (simulated, not live) wedge-completion estimate, comes out to
// ~500 vblanks — which already EXCEEDS the source's own 420-vblank budget
// cap. That makes the conclusion robust regardless of the unresolvable
// activation-timing ambiguity: the loop provably exhausts its budget before
// the gate can fire, so 420 (not a guessed round number) is the correct
// vblank count to hold for.
let WIPEIN_END = Infinity, RIPPLE_END = Infinity, HOLD_END = Infinity;
function stepWedge(row) {
  if (wedgeSub === 'prewait') {
    if ((row & 7) === 7) { wedgeSub = 'shrink'; wedgeStep = 0; wedgeBar = 0; }
  } else if (wedgeSub === 'wait') {
    if ((row & 7) === 7) { wedgeSub = 'flash'; wedgeStep = 0; }
  } else if (wedgeSub === 'shrink') {
    wedgeStep++;
    if (wedgeStep >= WEDGE_GROWTH.length) wedgeSub = 'wait';
  } else if (wedgeSub === 'flash') {
    wedgeStep++;
    if (wedgeStep >= 4) {
      wedgeBar++;
      if (wedgeBar >= 4) {
        wedgeDone = true;
        const wedgeEndFrame = frame + 1;   // doit1 begins the NEXT vblank
        DOIT1_END = wedgeEndFrame + 420;   // 70*6
        DOIT2_END = DOIT1_END + 840;       // 70*12
        DOIT3_BOX_END = DOIT2_END + 701;   // exact xpos-wipeout simulation
        WIPEIN_END = DOIT3_BOX_END + 53;
        RIPPLE_END = WIPEIN_END + 50;
        HOLD_END = RIPPLE_END + 420;       // musplus()-gate budget cap, see const declaration above
      } else { wedgeSub = 'shrink'; wedgeStep = 0; }
    }
  }
}

// --- assets ---
let sin1024 = null;
const sinAt = i => sin1024[i & 1023];
let picPal = null, picPix = null;   // panicpic.bin: 16-byte header + 768 (6-bit) + 320*400 chunky

export const technoVram = new Uint8Array(320 * 200);      // interference/box phases
export const technoVram400 = new Uint8Array(320 * 400);   // picture-reveal phases
export const technoPal = new Uint8Array(768);

// --- ring-interference canvases (built once from the raw _circle/_circle2
// bitmap extracts) --------------------------------------------------------
const CW = 640, CH = 400;
let bgVal = null;    // Uint8Array(CW*CH), 0-7 — static background (_circle's 3 planes)
let animBit = null;  // Uint8Array(CW*CH), 0/1 — animated foreground (_circle2)
let power0 = null;   // Int8Array(16*256) — koe.c's amplitude-scaling LUT

// exact bit-reversal of a byte (KOEA/KOEB's `flip8` table, used by bltlinerev
// to build the horizontally-mirrored half of each blitted row)
const FLIP8 = new Uint8Array(256);
for (let b = 0; b < 256; b++) {
  let r = 0; for (let i = 0; i < 8; i++) if (b & (1 << i)) r |= 1 << (7 - i);
  FLIP8[b] = r;
}
function bitAt(rowBytes, rowOff, x) { return (rowBytes[rowOff + (x >> 3)] >> (7 - (x & 7))) & 1; }

// 4-way-mirror a 200-row x 40-byte (320-bit) quarter bitmap into a 640x400
// bit canvas — exact port of init_interference's di/bp top+bottom loop with
// bltline (forward) + bltlinerev (flip8-reversed) for the left/right halves.
function mirror640x400(quarterBytes, rowStride) {
  const out = new Uint8Array(CW * CH);
  const revRow = new Uint8Array(40);
  for (let y = 0; y < 200; y++) {
    const rowOff = y * rowStride;
    for (let i = 0; i < 40; i++) revRow[i] = FLIP8[quarterBytes[rowOff + 39 - i]];
    const topRow = y * CW, botRow = (399 - y) * CW;
    for (let x = 0; x < 320; x++) {
      const l = bitAt(quarterBytes, rowOff, x), r = bitAt(revRow, 0, x);
      out[topRow + x] = l; out[topRow + 320 + x] = r;
      out[botRow + x] = l; out[botRow + 320 + x] = r;
    }
  }
  return out;
}

function buildPower0() {
  power0 = new Int8Array(16 * 256);
  for (let b = 0; b < 16; b++) {
    for (let c = 0; c < 256; c++) {
      if (b === 15) power0[b * 256 + c] = c < 128 ? c : c - 256;
      else { const a = c > 127 ? c - 256 : c; power0[b * 256 + c] = trunc(a * b, 15); }
    }
  }
}

export async function loadTechno() {
  const [picRes, tabRes, c1Res, c2Res] = await Promise.all([
    fetch('assets/panicpic.bin'), fetch('assets/tables.json'),
    fetch('assets/circle1.bin'), fetch('assets/circle2.bin')]);
  const raw = new Uint8Array(await picRes.arrayBuffer());
  picPal = raw.slice(16, 16 + 768);
  picPix = raw.slice(784, 784 + 320 * 400);
  sin1024 = Int16Array.from((await tabRes.json()).sin1024);

  const c1 = new Uint8Array(await c1Res.arrayBuffer());   // 24000B: 200 rows x [40B pl0][40B pl1][40B pl2]
  const c2 = new Uint8Array(await c2Res.arrayBuffer());   // 8000B: 200 rows x 40B
  // circle's 3 planes are interleaved per-row (40B pl0, 40B pl1, 40B pl2,
  // repeat) — de-interleave into 3 standalone 40B/row buffers before mirroring.
  const c1p0 = new Uint8Array(c1.length), c1p1 = new Uint8Array(c1.length), c1p2 = new Uint8Array(c1.length);
  for (let y = 0; y < 200; y++) {
    c1p0.set(c1.subarray(y * 120, y * 120 + 40), y * 120);
    c1p1.set(c1.subarray(y * 120 + 40, y * 120 + 80), y * 120);
    c1p2.set(c1.subarray(y * 120 + 80, y * 120 + 120), y * 120);
  }
  const p0 = mirror640x400(c1p0, 120), p1 = mirror640x400(c1p1, 120), p2 = mirror640x400(c1p2, 120);
  bgVal = new Uint8Array(CW * CH);
  for (let i = 0; i < CW * CH; i++) bgVal[i] = p0[i] | (p1[i] << 1) | (p2[i] << 2);
  animBit = mirror640x400(c2, 40);
  buildPower0();
  console.log('[TECHNO] tables + ring-interference canvases + 320x400 troll picture loaded');
}

export function technoMode400() { return frame >= DOIT3_BOX_END; }
export function technoEnded() { return HOLD_END !== Infinity && frame >= HOLD_END; }
export function technoEndFrames() { return HOLD_END; }
export function technoLocalFrames() { return frame; }

// ---------------------------------------------------------------------------
// popcount -> color lookup (box glow trail): base hue by plane-overlap count
// (0..4), scaled by the beat-flash envelope curpal (0..15). Exact port of
// koe.c's pal[16][16] construction + waitborder()'s per-channel scale factors.
// ---------------------------------------------------------------------------
const POP_BASE = [
  [0, 0, 0],
  [trunc(38 * 64, 111), trunc(33 * 64, 111), trunc(44 * 64, 111)],
  [trunc(52 * 64, 111), trunc(45 * 64, 111), trunc(58 * 64, 111)],
  [trunc(67 * 64, 111), trunc(61 * 64, 111), trunc(73 * 64, 111)],
  [trunc(83 * 64, 111), trunc(77 * 64, 111), trunc(89 * 64, 111)],
];
const POP_COLOR = Array.from({ length: 5 }, (_, pop) => Array.from({ length: 16 }, (_, c) => {
  const [r, g, b] = POP_BASE[pop];
  const rf = Math.min(63, trunc(r * (10 + c), 10));
  const gf = Math.min(63, trunc(g * (10 + trunc(c * 7, 9)), 10));
  const bf = Math.min(63, trunc(b * (10 + trunc(c * 5, 9)), 10));
  return [rf, gf, bf];
}));

// beat-flash envelope: fires curpal=15 on each dis_musrow()&7==7 edge (a
// constant-tempo periodic event here), decays by 1 every vblank after.
// row is edge-detected (not checked raw) because a row stays "current" for
// several vblanks — only the FIRST vblank of a new row should retrigger.
// curpalDraw is the level koe.c's waitborder() actually PROGRAMS this frame:
//   p=pal+16*3*curpal; ...write 16 DAC entries...; if(curpal) curpal--;
// the write happens BEFORE the decrement, so the beat frame shows pal[15] —
// which is why curpalDraw is captured before the decrement.
let curpal = 0, curpalDraw = 0, lastRow = -1;
function beatStep(fIdx, useLive) {
  const row = currentRow(fIdx, useLive);
  if (row !== lastRow) {
    lastRow = row;
    if ((row & 7) === 7) curpal = 15;
  }
  const use = curpal;
  if (curpal > 0) curpal--;
  curpalDraw = use;
  return use;
}

// ---------------------------------------------------------------------------
// Box shape: 11 nested parallel-rectangle outlines (asmbox x11, offset by c),
// even-odd (XOR) scanline fill == koe.c's asmbox->blit16 span-fill algorithm.
// ---------------------------------------------------------------------------
function boxQuads(rot, vm, doubleScale, cx0, cy0, out) {
  const hx = trunc(sinAt(rot) * 16 * 6, 5);
  const hy = sinAt(rot + 256) * 16;
  const vxBase = trunc(sinAt(rot + 256) * 6, 5);
  const vyBase = sinAt(rot + 512);
  const vmEff = doubleScale ? trunc(vm, 64) : vm;
  const vx = trunc(vxBase * vmEff, 100);
  const vy = trunc(vyBase * vmEff, 100);
  let o = 0;
  for (let c = -10; c <= 10; c += 2) {
    const ccx = vx * c * 2, ccy = vy * c * 2;
    out[o++] = trunc(-hx - vx + ccx, 16) + cx0; out[o++] = trunc(-hy - vy + ccy, 16) + cy0;
    out[o++] = trunc(-hx + vx + ccx, 16) + cx0; out[o++] = trunc(-hy + vy + ccy, 16) + cy0;
    out[o++] = trunc(hx + vx + ccx, 16) + cx0;  out[o++] = trunc(hy + vy + ccy, 16) + cy0;
    out[o++] = trunc(hx - vx + ccx, 16) + cx0;  out[o++] = trunc(hy - vy + ccy, 16) + cy0;
  }
}
const quadBuf = new Int32Array(11 * 8);
const xsBuf = new Float64Array(96);
function rasterizeMask(mask) {
  mask.fill(0);
  for (let y = 0; y < 200; y++) {
    const yc = y + 0.5;
    let n = 0;
    for (let q = 0; q < 11; q++) {
      const o = q * 8;
      for (let e = 0; e < 4; e++) {
        const e2 = (e + 1) & 3;
        const x0 = quadBuf[o + e * 2], y0 = quadBuf[o + e * 2 + 1];
        const x1 = quadBuf[o + e2 * 2], y1 = quadBuf[o + e2 * 2 + 1];
        if (y0 === y1) continue;
        const ylo = y0 < y1 ? y0 : y1, yhi = y0 < y1 ? y1 : y0;
        if (yc < ylo || yc >= yhi) continue;
        xsBuf[n++] = x0 + (yc - y0) / (y1 - y0) * (x1 - x0);
      }
    }
    const xs = xsBuf.subarray(0, n);
    xs.sort();
    const rowBase = y * 320;
    for (let i = 0; i + 1 < n; i += 2) {
      let xa = Math.ceil(xs[i] - 0.5), xb = Math.ceil(xs[i + 1] - 0.5);
      if (xa < 0) xa = 0; if (xb > 320) xb = 320;
      if (xb > xa) mask.fill(1, rowBase + xa, rowBase + xb);
    }
  }
}

// ring buffer of the last 32 box-shape masks (need lookback of 8/16/24)
const RING = 32;
const maskRing = Array.from({ length: RING }, () => new Uint8Array(320 * 200));
let boxFrame = -1;   // frames since doit1 started (continuous through doit1/2/3)

// doit1/doit2/doit3 rotation/scale state (only rot/vm/etc reset per doit()
// call, matching koe.c's locals — the mask-history ring is never cleared)
let rot = 45, vm = 50, vma = 0, rota = 10, rot2 = 0;
let xpos3 = 320, xposa3 = 0;   // doit3's wipe-to-black pan

function stepBoxFrame(mode) {
  boxFrame++;
  let cx0 = 160, cy0 = 100;
  if (mode === 3) {
    cx0 = (rot2 < 32) ? trunc(sinAt(rot2) * rot2, 8) + 160 : trunc(sinAt(rot2), 4) + 160;
    cy0 = (rot2 < 32) ? trunc(sinAt(rot2 + 256) * rot2, 8) + 100 : trunc(sinAt(rot2 + 256), 4) + 100;
    rot2 += 17;
    // wipe-to-black trigger: doit3's `count<333` == 647 frames into doit3
    const doit3Local = frame - DOIT2_END;
    if (doit3Local >= 647) {
      xpos3 -= trunc(xposa3, 4);
      if (xpos3 < 0) xpos3 = 0; else xposa3++;
    }
  }
  boxQuads(rot, vm, mode !== 1, cx0, cy0, quadBuf);
  rasterizeMask(maskRing[boxFrame & (RING - 1)]);
  if (mode === 1) {
    rot += 2; vm += vma;
    if (vm < 25) { vm -= vma; vma = -vma; }
    vma--;
  } else {
    rot += trunc(rota, 10); vm += vma;
    if (vm < 0) { vm -= vma; vma = -vma; }
    vma--; rota++;
  }
}

function drawBoxComposite(curpalNow, panShift) {
  const m0 = maskRing[boxFrame & (RING - 1)];
  const m8 = boxFrame >= 8 ? maskRing[(boxFrame - 8) & (RING - 1)] : null;
  const m16 = boxFrame >= 16 ? maskRing[(boxFrame - 16) & (RING - 1)] : null;
  const m24 = boxFrame >= 24 ? maskRing[(boxFrame - 24) & (RING - 1)] : null;
  technoVram.fill(0);
  for (let y = 0; y < 200; y++) {
    const rowBase = y * 320;
    for (let x = 0; x < 320; x++) {
      const sx = x - panShift;
      if (sx < 0 || sx >= 320) continue;
      const i = rowBase + sx;
      let pop = m0[i];
      if (m8 && m8[i]) pop++;
      if (m16 && m16[i]) pop++;
      if (m24 && m24[i]) pop++;
      technoVram[rowBase + x] = pop;
    }
  }
  for (let p = 0; p <= 4; p++) {
    const [r, g, b] = POP_COLOR[p][curpalNow];
    technoPal[p * 3] = r; technoPal[p * 3 + 1] = g; technoPal[p * 3 + 2] = b;
  }
}

// ---------------------------------------------------------------------------
// dointerference2 (KOEB): KOEB's init_interference builds the exact same
// _circle/_circle2-derived static ring canvas as KOEA's (see the big header
// comment) — it's the SAME bgVal canvas built once in loadTechno, reused
// here. do_interference's per-frame sprite blit is dead code here (`jmp
// @@OVER3`), so bit3 (the animated _circle2 layer) never gets set; only the
// 16-color palette (pal0 mixed via palfader, an exact port of mixpal/
// palfader's ramp) animates — and pal0 is black at every DAC index except 0
// and 8 (both (0,30,40)), so only pixels where the static value is exactly
// 0 (all 3 of _circle's planes clear at that pixel) ever show the pulsing
// cyan-to-white color; everything else stays black. KOEB's own scrnx/scrny
// zoom-orbit (a separate "sizefade" variable from KOEA's) is degenerate in
// this build — its only increment is commented out in the source (`;add
// ax,256`), so sizefade stays 0 forever and the window never moves — hence
// no panning is needed here, unlike the live dointerference phase.
// ---------------------------------------------------------------------------
// mixpal(pal0[slot], palfader): applied UNIFORMLY per byte, so entries that
// start at 0 (every slot's R, and slots 1-7 entirely) stay black through the
// first half (dx<=256, a multiplicative ramp that keeps 0*x=0), then ramp
// toward white ADDITIVELY in the second half (dx>256) exactly like slot 0's
// nonzero channels do — i.e. ALL 8 colors converge to white by the end, not
// just slot 0.
function mixpalChannel(base, dx) {
  return dx <= 256 ? trunc(base * dx, 256) : Math.min(63, base + (dx - 256));
}
function drawIf2(f) {
  // pal0 is declared as its own 8-entry (0,30,40)+7x(0,0,0) sequence
  // DOUBLED to 16 entries (matching KOEA's pal1/pal2 doubling trick), and
  // do_interference() reads 8 consecutive entries starting at a rotating
  // byte offset (palanimc, -3/frame, matching KOEA's cycle exactly) — so
  // which of the 8 OUTPUT dac slots lands on the (0,30,40) source entry
  // rotates by +1 each frame: cyanSlot = (8 - palanimc/3) % 8.
  const start = trunc((24 - ((f * 3) % 24)) % 24, 3);
  const cyanSlot = (8 - start) % 8;
  const dx = Math.min(512, f * 2);
  for (let k = 0; k <= 7; k++) {
    const g0 = k === cyanSlot ? 30 : 0, b0 = k === cyanSlot ? 40 : 0;
    technoPal[k * 3] = mixpalChannel(0, dx);
    technoPal[k * 3 + 1] = mixpalChannel(g0, dx);
    technoPal[k * 3 + 2] = mixpalChannel(b0, dx);
  }
  const windowLeft = 160, windowTop = 100;   // KOEB's window never pans (see comment above)
  for (let y = 0; y < 200; y++) {
    const bgRow = (windowTop + y) * CW, rowBase = y * 320;
    for (let x = 0; x < 320; x++) {
      technoVram[rowBase + x] = bgVal[bgRow + windowLeft + x];
    }
  }
}

// ---------------------------------------------------------------------------
// dointerference (KOEA): ring-interference pattern, composited live each
// frame from the two precomputed 640x400 canvases (bgVal/animBit — see
// loadTechno). Exact port of do_interference()'s per-row loop: a per-row
// sine-wave horizontal offset (amplitude-scaled by sinuspower via power0,
// koe.c's own LUT) positions the _circle2-sourced animated foreground; the
// static _circle background pans only via which 320x200 window is visible
// (the slow scrnx/scrny orbit). No 8-copy bit-rotation trick is needed here
// (that existed only to sub-pixel-shift a bit-packed VGA buffer) — sampling
// the decoded pixel array directly at the exact offset is equivalent and
// exact, not an approximation.
// ---------------------------------------------------------------------------
// DAC entries 0..7 come from KOEA's pal1 (KOEA.ASM:460) and 8..15 from KOEA's
// pal2 (KOEA.ASM:442) — do_interference does two outpal calls, `al=0, cx=8*3,
// si=pal1+palanimc` then `al=8, cx=8*3, si=pal2+palanimc`. Not KOEB's pal2
// (KOEB.ASM:75, the `*6/9` table that starts 50,60,30,0,...), which belongs to
// dointerference2 and is a different ramp entirely.
const KOEA_PAL1 = [30, 60, 50, 40, 30, 20, 10, 0].map(v => [v, trunc(v * 8, 9), v]);
const KOEA_PAL2 = [0, 10, 20, 30, 40, 50, 60, 30].map(v => [v, trunc(v * 7, 9), v]);
let wScrnrot = 0, wOverrot = 211, wSinuspower = 0, wPowerCnt = 0, wPalanimc = 0, wSinurot = 0;
// `patdir dw 0` (KOEA.ASM:642) — the palette cycle starts UNARMED and only ever
// becomes -3 once the music's row&7 has landed on 0 or 4 (KOEA.ASM:821-830).
let wPatdir = 0;

function stepWobble(row) {
  if (row != null) { const r = row & 7; if (r === 0 || r === 4) wPatdir = -3; }
  wPalanimc += wPatdir;
  if (wPalanimc < 0) wPalanimc = 21; else if (wPalanimc >= 24) wPalanimc = 0;
  wScrnrot = (wScrnrot + 5) & 1023;
  wOverrot = (wOverrot + 7) & 1023;
  // sinurot advances +7 ENTRIES PER FRAME and no more: the ASM does
  //   mov bp,sinurot / add bp,7*2 / and bp,2047 / mov sinurot,bp
  // and only then enters the 200-row loop, which adds 9*2 to the LOCAL bp per
  // row and never stores it back — storing the accumulated per-row phase would
  // advance the wave by 200*9 mod 1024 = +776 per drawn frame instead of +7.
  wSinurot = (wSinurot + 7) & 1023;
  const w = frame - IF2_END;
  if (w >= 350) { wPowerCnt++; if (wPowerCnt >= 16) { wPowerCnt = 0; if (wSinuspower < 15) wSinuspower++; } }
}
function drawWobble() {
  const scrnx = 160 + (sinAt(wScrnrot) >> 2), scrny = 100 + (sinAt(wScrnrot + 256) >> 2);
  const overx = 160 + (sinAt(wOverrot) >> 2), overy = 100 + (sinAt(wOverrot + 256) >> 2);
  const start = trunc(wPalanimc, 3);
  // Window into the static 640x400 background, at FULL pixel precision. The
  // original splits scrnx across two registers — CRTC start address gets the
  // byte part (`scrnpos = 80*scrny + (scrnx>>3)`) and the ATC's Horizontal
  // Pixel Panning register (index 0x13) gets the remainder
  // (`scrnposl = scrnx & 7`, written at the top of do_interference) — so the
  // visible left edge is (scrnx>>3)*8 + (scrnx&7) = scrnx exactly; without the
  // pel-pan half the background's orbit would move in 8-pixel jumps.
  // (do_interference also folds `-scrnposl` into the ANIMATED layer's offset,
  // which under the original's destination-offset convention leaves that layer
  // jittering by -2*scrnposl relative to the background. It is not transplanted
  // here: this port samples the animated canvas with a SOURCE offset, the
  // opposite sign convention, so the term cannot be copied across without first
  // inverting the sampling — and the canvas is 4-way mirrored, which is why the
  // existing convention passed video verification. Left as a known residual.)
  const windowLeft = scrnx, windowTop = scrny;
  let phase = wSinurot;   // entries into sin1024, +9/row (matches ASM's bp+=9*2 byte-offset)
  for (let y = 0; y < 200; y++) {
    phase = (phase + 9) & 1023;
    const shifted = sinAt(phase) >> 3;              // arithmetic shift, matches x86 SAR
    const amp = power0[wSinuspower * 256 + (shifted & 0xff)];
    const ax = amp + overx;                          // animated foreground's column offset
    const animRow = ((y + overy) % CH + CH) % CH;
    const bgRow = ((windowTop + y) % CH + CH) % CH;
    const bgRowOff = bgRow * CW, animRowOff = animRow * CW;
    const rowBase = y * 320;
    for (let x = 0; x < 320; x++) {
      const bgCol = (windowLeft + x) % CW;
      const animCol = ((ax + x) % CW + CW) % CW;
      const v = bgVal[bgRowOff + bgCol] | (animBit[animRowOff + animCol] << 3);
      technoVram[rowBase + x] = v;
    }
  }
  // NOTE: `phase` is deliberately NOT written back to wSinurot — see stepWobble.
  for (let k = 0; k < 8; k++) {
    const p1 = KOEA_PAL1[(start + k) % 8], p2 = KOEA_PAL2[(start + k) % 8];
    technoPal[k * 3] = p1[0]; technoPal[k * 3 + 1] = p1[1]; technoPal[k * 3 + 2] = p1[2];
    technoPal[(8 + k) * 3] = p2[0]; technoPal[(8 + k) * 3 + 1] = p2[1]; technoPal[(8 + k) * 3 + 2] = p2[2];
  }
}

// ---------------------------------------------------------------------------
// Wedge transition: exact beat-synchronized port of koe.c's growing-bars
// wipe (see stepWedge above + the header comment for the full derivation).
// Bar geometry: 4 vertical stripes (80px each, matching the original's
// 40-column tweak-mode canvas at 8x stretch), each bar's OWN black region
// grows quadratically top-down over 21 fixed vblanks (WEDGE_GROWTH), fully
// independent of the beat; only the GAP between bars (waiting for the next
// dis_musrow()&7==7, checked against the LIVE music engine) is beat-driven
// — so "the stripes fall on the beat" means each bar's growth-start (and
// the flash marking it) lands on a beat, not that the growth itself is
// beat-metered.
// ---------------------------------------------------------------------------
// The wedge's own 16-entry palette. Right after dointerference, koe.c does
//     ip=flash(-2); for(a=0;a<16;a++){ ip[a*3+0]=a*6/2; ip[a*3+1]=a*7/2;
//                                      ip[a*3+2]=a*8/2; }
// which overwrites flash()'s pal1 with a blue-tinted ramp — so entry 0 (the
// grown bars) is black and entry 15 (the memset(vram,255,8000) background) is
// (45,52,60), a pale lavender.
const WEDGE_PAL1 = Array.from({ length: 16 }, (_, a) =>
  [trunc(a * 6, 2), trunc(a * 7, 2), trunc(a * 8, 2)]);
// flash(i) for i>=0: pal2[k] = (pal1[k]*(256-i) + 63*i)>>8, written to DAC
// entries 0..15 — ALL SIXTEEN, not just the bar colour.
const flashBlend = (base, i) => trunc(base * (256 - i) + 63 * i, 256);
const WHITE_FLASH = [32, 64, 192, 256];

function drawWedge() {
  // koe.c's order is: dointerference() returns -> flash(-1) captures the blob's
  // final DAC -> flash(32/64/192/256) ramps it to white over 4 vblanks -> ONLY
  // THEN the CRTC switch + memset(vram,0)/memset(vram,255,8000). So the blob is
  // still the picture on screen while it whitens out, and the screen then stays
  // white through both music gates until the first bar starts growing.
  const wf = frame - WOBBLE_END;
  if (wf < WHITE_FLASH.length) {
    // rebuild the blob's last frame (the wobble state stopped advancing at
    // WOBBLE_END, so this is exactly frame WOBBLE_END-1's raster and palette —
    // and it stays correct when a jump replay only draws the final frame), then
    // blend its 16 DAC entries toward white.
    drawWobble();
    const i = WHITE_FLASH[Math.max(0, wf)];
    for (let k = 0; k < 48; k++) technoPal[k] = flashBlend(technoPal[k], i);
    return;                              // leave the blob raster on screen
  }

  // 320x200 of colour 15 (40 bytes/row x 8 pixels in the 16-colour planar
  // wedge mode), bars carved out in colour 0. 254 is just this port's stand-in
  // index for entry 15 so the box phases' own use of 0..15 stays clear.
  technoVram.fill(254);
  let flashLevel = 256;                  // 'prewait': still fully white
  if (wedgeSub !== 'prewait') {
    const barsGrown = wedgeBar + (wedgeSub === 'shrink' ? 0 : 1);   // bars strictly before this one are fully black
    for (let b = 0; b < barsGrown; b++) for (let y = 0; y < 200; y++) technoVram.fill(0, y * 320 + b * 80, y * 320 + b * 80 + 80);
    flashLevel = 0;                      // 'wait': DAC sits on pal1 exactly
    if (wedgeSub === 'shrink') {
      // Each of the 21 steps memsets only its OWN new band (rows zly..zy-1),
      // but it writes into VRAM the earlier steps already blacked out, so the
      // bar's black region ACCUMULATES from row 0 down: after step k it covers
      // rows 0..zy_k-1 (zy_k = k(k+1)/2, reaching 200 well before step 21).
      // This port rebuilds the canvas every frame, so it has to fill the whole
      // accumulated region — drawing just the current band left a single
      // detached stripe sliding down an otherwise untouched bar.
      const g = WEDGE_GROWTH[wedgeStep];
      for (let y = 0; y < g.zy; y++) technoVram.fill(0, y * 320 + wedgeBar * 80, y * 320 + wedgeBar * 80 + 80);
      flashLevel = Math.max(0, g.a);     // a = 256,224,..,32,0 then flash(0)
    } else if (wedgeSub === 'flash') {
      flashLevel = WHITE_FLASH[wedgeStep];
    }
  }
  const bar = WEDGE_PAL1[0], bg = WEDGE_PAL1[15];
  for (let c = 0; c < 3; c++) {
    technoPal[c] = flashBlend(bar[c], flashLevel);
    technoPal[254 * 3 + c] = flashBlend(bg[c], flashLevel);
  }
}

// ---------------------------------------------------------------------------
// Picture reveal: wipe-in, ripple/settle, hold. Same horizontal-pan formula
// as doit3's wipeout (koe.c reuses the identical xpos/xposa idiom).
// ---------------------------------------------------------------------------
let pXpos = 0, pXposa = 0, pRipple = 0, pRipplep = 8;
// The reveal is pure CRTC addressing over linear VRAM, and reproducing that
// addressing (rather than "draw the picture shifted by 320-xpos") is what makes
// the ripple correct.
//
// koe.c sets CRTC Offset = 80 -> 160 bytes per scanline = 640 pixels of canvas
// per row in this unchained 4-plane mode, and blits the 320x400 troll picture at
// byte +80 of each row, i.e. canvas pixels 320..639. The left 320 pixels of every
// canvas row are the black the mode-set left behind. Each reveal frame then does
//     a = xpos/4;  CRTC reg 0x0d = a          (start address LOW byte only)
//     a = (xpos&3)*2;  ATC reg 0x13 = a       (horizontal pixel panning)
// so the window's first canvas pixel is startByte*4 + (xpos&3), and display row
// y reads canvas bytes start + y*160 onward — a single linear address space.
// Screen (x,y) therefore shows canvas pixel start + x + y*640, which for xpos>320
// runs off the right end of picture row y and into the BLACK left half of row
// y+1, not back into row y's own pixels.
//
// Two details of the hardware/C mix matter once the ripple drives xpos wild
// (xpos = 320 + sin1024[..]/ripplep, and ripplep starts at 8):
//   * only the start address LOW byte is written, so the byte offset wraps mod
//     256 (the high byte stays 0 from the int-10h mode set) — that wrap IS the
//     ripple's violent snap;
//   * C's xpos/4 truncates toward zero while xpos&3 is a two's-complement AND,
//     so the two disagree for negative xpos, exactly as the original does.
const PICT_CW = 640;                    // canvas pixels per row (CRTC offset 80)
function panReveal400(xposNow) {
  technoVram400.fill(0);
  const startByte = (Math.trunc(xposNow / 4)) & 0xff;   // reg 0x0d, low byte only
  const start = startByte * 4 + (xposNow & 3);          // + ATC pel pan
  for (let y = 0; y < 400; y++) {
    const rowBase = y * 320;
    const canvas0 = start + y * PICT_CW;
    for (let x = 0; x < 320; x++) {
      const c = canvas0 + x;
      const cy = Math.floor(c / PICT_CW), cx = c - cy * PICT_CW;
      if (cy < 0 || cy >= 400 || cx < 320) continue;    // off-canvas or the black half
      technoVram400[rowBase + x] = picPix[cy * 320 + (cx - 320)];
    }
  }
}

// ---------------------------------------------------------------------------
// Frame stepping — cheap per-vblank state advance (called for every simulated
// frame, even during a fast-forward replay); the expensive raster/composite
// only runs once, for the frame actually being displayed (drawFrame).
// ---------------------------------------------------------------------------
let frame = -1;
let prewaitDone = false;     // KOE.C:213 while(dis_musplus()<-4)
let preWedgeDone = false;    // KOE.C:275 while(dis_musplus()<-3) before wedge

export function technoReset() {
  frame = -1; boxFrame = -1; prewaitDone = false; preWedgeDone = false;
  rot = 45; vm = 50; vma = 0; rota = 10; rot2 = 0;
  xpos3 = 320; xposa3 = 0;
  curpal = 0; curpalDraw = 0; lastRow = -1;
  wScrnrot = 0; wOverrot = 211; wSinuspower = 0; wPowerCnt = 0; wPalanimc = 0; wSinurot = 0; wPatdir = 0;
  pXpos = 0; pXposa = 0; pRipple = 0; pRipplep = 8;
  wedgeBar = 0; wedgeSub = 'prewait'; wedgeStep = 0; wedgeDone = false;
  DOIT1_END = Infinity; DOIT2_END = Infinity; DOIT3_BOX_END = Infinity;
  WIPEIN_END = Infinity; RIPPLE_END = Infinity; HOLD_END = Infinity;
  liveRow = null;
  technoVram.fill(0); technoVram400.fill(0);
}

function stepOneFrame(useLive, musplusAtLocal) {
  frame++;
  const localS = frame / VBLANK_HZ;
  const getM = musplusAtLocal || (() => -32);

  // PREWAIT: while(dis_musplus()<-4); — prefer live/sim gate; if the lower-
  // bound simulator never opens zplus, fall back to the measured 49 frames.
  if (!prewaitDone) {
    if (getM(localS) >= -4 || frame >= PREWAIT_FRAMES) {
      prewaitDone = true;
      if (frame < PREWAIT_FRAMES) frame = PREWAIT_FRAMES; // align IF2_END chain
    } else {
      return; // solid black
    }
  }

  // doit1/doit2/doit3 are separate C-function calls in the original, each
  // with its OWN local rot/vm/vma/rota — reset exactly at each boundary.
  if (frame === DOIT1_END) { rot = 50; rota = 10; vm = 100 * 64; vma = 0; }
  else if (frame === DOIT2_END) {
    rot = 45; rota = 10; rot2 = 0; vm = 100 * 64; vma = 0; xpos3 = 320; xposa3 = 0;
    for (const h of maskRing) h.fill(0);
  }

  if (frame < IF2_END) { /* drawIf2 at draw time */ }
  else if (frame < WOBBLE_END) { stepWobble(currentRow(frame, useLive)); }
  else if (frame < WOBBLE_END + WHITE_FLASH.length) {
    // koe.c's flash(-1)/flash(32)/flash(64)/flash(192)/flash(256) — 4 vblanks
    // (each flash(i>=0) calls dis_waitb) whitening out the blob BEFORE the mode
    // switch and both music gates. Draw-time only; nothing to step.
  } else if (!preWedgeDone) {
    // KOE.C:275 while(dis_musplus()<-3); before the wedge beat-wait
    if (getM(localS) >= -3 || frame > WOBBLE_END + WHITE_FLASH.length + 140) preWedgeDone = true;
    else return; // hold the white screen
  }
  if (!preWedgeDone) return;

  if (!wedgeDone) { stepWedge(currentRow(frame, useLive)); }
  else if (frame < DOIT1_END) { beatStep(frame, useLive); stepBoxFrame(1); }
  else if (frame < DOIT3_BOX_END) {
    beatStep(frame, useLive);
    // KOE.C doit3 also holds a global-counter hard cut —
    // `a=dis_getmframe(); if(a>2520) { if(xpos!=0) xpos=0; else break; }` —
    // which is deliberately NOT modeled here: this port has no faithful
    // mframe clock to test it against. mframe's tick rate is only
    // pinned where a measurement pinned it (669 ticks across the wobble's
    // 987 real vblanks — see WOBBLE_END); extrapolating ANY assumed rate
    // through the wedge/doit phases puts mframe>2520 just ~136 frames into
    // doit3's orbit (demo ~208.6) — flatly contradicted by the reference
    // capture, which shows the full 647-frame orbit + gradual `count<333`
    // wipe-out, and by both part-end measurements (live mt~223.6; video
    // troll-hold until ~225.07 = demo ~224). In the real
    // demo the check evidently never preempted the wipe, so the video-
    // verified fixed chain (DOIT3_BOX_END = DOIT2_END + 701, set in
    // stepWedge) stays authoritative. Verify against a real cumulative mframe
    // count (or read the live equivalent, as the wedge does for dis_musrow)
    // before re-attempting this one.
    stepBoxFrame(frame >= DOIT2_END ? 3 : 2);
  } else if (frame < WIPEIN_END) {
    pXpos += trunc(pXposa, 4);
    if (pXpos > 320) pXpos = 320; else pXposa++;
  } else if (frame < RIPPLE_END) {
    if (pRipplep > 1023) pRipplep = 1024; else pRipplep = trunc(pRipplep * 5, 4);
    pXpos = 320 + trunc(sinAt(pRipple), pRipplep);
    pRipple += pRipplep + 100;
  } else {
    pXpos = 320;
  }
}

function drawFrame() {
  if (frame < PREWAIT_FRAMES) {
    technoVram.fill(0);
    technoPal.fill(0);
  } else if (frame < IF2_END) {
    drawIf2(frame - PREWAIT_FRAMES);
  } else if (frame < WOBBLE_END) {
    drawWobble();
  } else if (!wedgeDone) {
    drawWedge();
  } else if (frame < DOIT3_BOX_END) {
    const panShift = frame >= DOIT2_END ? (320 - xpos3) : 0;
    drawBoxComposite(curpalDraw, panShift);
  } else if (frame < WIPEIN_END) {
    // koe.c sets the full picture palette once, before the wipe-in loop —
    // the reveal itself is a hard-edged pixel-pan, not a fade.
    panReveal400(pXpos);
    technoPal.set(picPal);
  } else if (frame < RIPPLE_END) {
    // only the ripple/settle loop dims via palfade[c] for its first 16 frames
    panReveal400(pXpos);
    const fadeIdx = Math.max(0, Math.min(15, frame - WIPEIN_END));
    const off = 45 - fadeIdx * 3;
    for (let i = 0; i < 768; i++) technoPal[i] = Math.max(0, Math.min(63, picPal[i] - off));
  } else {
    panReveal400(pXpos);
    technoPal.set(picPal);
  }
}

// advance to techno-local time tt (seconds since part start). liveRowArg is
// chip.row from main.js (the REAL currently-playing music engine's row, via
// libopenmpt — see currentRow's derivation comment above) or null/undefined
// in ?silent mode where no real audio engine is running. Only used for the
// FINAL step below — any earlier catch-up steps in the same call have no
// corresponding historical live value (just the current snapshot), so they
// fall back to the simulated clock, same as a full replay always does.
// liveRowArg = chip.row; musplusAtLocal(s) = dis_musplus at techno-local seconds.
export function technoStepTo(tt, replay, liveRowArg, musplusAtLocal) {
  if (liveRowArg != null) liveRow = liveRowArg;
  if (HOLD_END !== Infinity && frame >= HOLD_END) return false;
  const cap = HOLD_END === Infinity ? Math.floor(tt * VBLANK_HZ) + 1 : HOLD_END;
  const target = Math.min(cap, Math.floor(tt * VBLANK_HZ));
  let steps = target - frame;
  if (steps <= 0) { drawFrame(); return HOLD_END === Infinity || frame < HOLD_END; }
  if (steps > 35 && !replay) steps = 35;
  for (let s = 0; s < steps && (HOLD_END === Infinity || frame < HOLD_END); s++) {
    stepOneFrame(!replay && s === steps - 1, musplusAtLocal);
  }
  drawFrame();
  return HOLD_END === Infinity || frame < HOLD_END;
}
