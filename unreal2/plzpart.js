// PLZPART — plasma (PLZ.C + ASMYT.ASM + COPPER.ASM) then textured vector
// cube (VECT.C + PLZA.ASM + SPLINE.ASM + PLZFILL.C).  Source-exact port;
// every constant's derivation:
//
// TIMING MODEL
// - Part-local frame clock at VBLANK_HZ=70 driven by main.js (phase-local
//   seconds via plzpartStepTo, musplusFn = s3msim dis_musplus() model).
// - PREWAIT: PLZ.C:68 `while(dis_musplus()<0);` — pure musplusFn
//   pass-through, no hidden constants.  MAIN.C installs the copper BEFORE
//   plz() and COPPER.ASM:104-107 runs moveplz every vblank, so the k/l
//   plasma phase params advance during the prewait too (at 70 Hz: the CPU
//   only spins on the gate, no render load).  The screen holds the
//   previous part's final state; LNS&ZOOM ends faded to white (reference
//   video ~305.8s) and init_plz (PLZ.C:179) then sets the whole DAC white
//   — the entire entry seam is white, which reset() sets up.
// - MFRAME_HZ = 52.4: dis_getmframe()'s real tick rate DURING THE PLASMA
//   RENDER LOOP, capture-measured (same lesson as techno.js WOBBLE_END —
//   an interrupt-fed counter does NOT tick at a clean 70 Hz under heavy
//   render load).  Reference video (yt-dlp iw17c70uJes): screen-falls
//   start at plasma-relative ~13.8s / ~28.55s / ~36.05s for TIMETABLE
//   hits 723/1491/1875 → 723/13.8 = 52.4 Hz (residual < 0.3s across all
//   three).  ALL interrupt-driven plasma-phase machinery (mframe,
//   cop_drop, moveplz, fadepal accumulation) is fed by the same interrupt
//   chain, so the whole plasma phase runs on one tick clock at MFRAME_HZ,
//   converted per 70 Hz frame via a fractional accumulator.
// - TIMETABLE [723,1491,1875] = PLZ.C:46 64*6*2-45, 64*6*4-45, 64*6*5-45,
//   in mframe ticks (event fires at the first `mframe>table` poll).
//   THREE stages, not four: dev-tree PLZ.C (curpal pre-increment + break
//   at curpal==5, PLZ.C:73,94) predicts a 4th event at 2259 — but the
//   SHIPPED MAIN/DATA/PLZPART.EXE provably differs from the dev tree (its
//   unpacked image — two independent PKLITE decompressors, deark and
//   depklite, agree byte-for-byte — contains the same timetable ints but
//   none of PLZ.OBJ's compiled code patterns, and PLZPART.MAP's link
//   layout does not fit it), and the reference capture unambiguously
//   shows THREE falls with the vect cube entering right after the third.
//   The capture also pins the displayed palette sequence = white→pals[0]
//   (red/blue), pals[1] (green/teal), pals[2] (greyscale) — exactly the
//   dev palette tables, so only the stage COUNT differs.  Port: the
//   PLZ.C:94 break fires when the 3rd event's drop reaches cop_drop>64.
// - Stage drop machinery = COPPER.ASM do_drop, in ticks: cop_drop set 1
//   at the event; ticks 2..64 sweep VGA linecompare through DTAU
//   (quadratic "gravity", COPPER.ASM:175-181: i*i/4*43/128+60) — the old
//   plasma visibly falls off the bottom; at 65 linecompare=400 (blank)
//   and initpparas loads the new k/l from INITTABLE (COPPER.ASM:256-297);
//   ticks 66..96 accumulate the new palette up from black
//   (memset(fadepal,0,768) PLZ.C:81) in 8.8 fixed point (delta =
//   pals[n]*8 per PLZ.C:217 → 31 accumulates ≈ 97% brightness,
//   source-exact).
// - Entry fade: cop_drop=128 (PLZ.C:72) → 127 accumulates of (v-63)*2
//   deltas (PLZ.C:216) from a fadepal accumulator starting at 63<<8:
//   white→pals[0] over ~128 ticks (~2.44s at 52.4 Hz; capture: white at
//   video 306.5, half-faded 308.0, done ~309.3 ✓).  fadepal is formally
//   uninitialized in source (dup(?) COPPER.ASM:184); 63<<8 is the only
//   start consistent with the white DAC and the capture.
// - VECT entry: VECT.C:116 `while(dis_musplus()<13);` — pure pass-through
//   (nominal: gate opens ~0.2s after plasma end; screen is black from the
//   plasma break to the first cube frame).  Safety cap 30s, unreachable.
// - VECT exit: VECT.C:119-120 `a>=-4 && a<0` — evaluated EVERY frame
//   including replay (minvball.js convention: seeks must hit the same
//   transition as live play).  No source cap; 120s labeled
//   unreachable-safety only.
//
// PLASMA RENDERING (ASMYT.ASM:41-69 unrolled loop as patched by
// setplzparas ASMYT.ASM:74-93 — NOT the commented-out C macro at
// PLZ.C:15): per output byte n (4 unchained pixels) of line y, with
// c1..c4 the k or l params:
//   field = psini[lsini16[y+c2+320-4n] + c1 + 8n]
//         + psini[lsini4[y+c4+16n] + 2y + c3 + 320 - 4n]   (mod 256)
// computed with full 16-bit segment-offset wrap (psini at 0x0000, lsini4
// at 0x4000, lsini16 at 0x8000 in one 64K segment = the ASMYT layout;
// table assets byte-verified against the .INC/.PRE data).  PLZ.C:96-117
// writes the k-field and l-field to complementary plane pairs (map mask
// 0Ah/05h) with an even/odd line swap → per-PIXEL checkerboard:
// pixel(x,y) shows the k-field when (x+y)&1, else the l-field.
// Mode (TWEAK.ASM tw_opengraph2): 320x400 unchained, 96-byte pitch,
// linecompare split at 60 with display start 96*(682-400) (PLZ.C:176-177)
// → scanlines 0..59 show unwritten VRAM (colour 0), 60..339 plasma lines
// 0..279, 340..399 colour 0 — capture-confirmed (plasma band in the
// middle 70%, colour-0 bars fading white→black above/below).  Rendered at
// that NATIVE 320x400 (plzpartVram400 / plzpartMode400), not sampled down
// to 320x200 and line-doubled: the k/l checker is one pixel in both axes,
// so a 200-row raster pinned the line parity and turned it into fixed 1px
// vertical columns — see renderPlasma's comment.  The 70 Hz
// pompota one-line/half-pixel interlace jitter (COPPER.ASM:126-143) is
// still not reproduced per-frame (a 60 fps browser would alias it into
// irregular flicker rather than blend it); it exists to soften this very
// checker on a CRT, and at native resolution there is little left to
// soften.  We render the linecompare-60 phase.
//
// VECT RENDERING (VECT.C):
// - Mode (tw_opengraph): 640x134 unchained, 160-byte pitch, max-scan-line
//   2 (each row on 3 of 400 scanlines), display start = page+40 bytes →
//   visible window = buffer pixels 160..479.  Output row r samples
//   scanline 2r → vect row floor(2r/3).  The 6-page half-pixel jitter
//   ((page&1)*2 + pel-pan 4, VECT.C:249-298) is not reproduced (same
//   reasoning as pompota; even phase rendered), and the current frame is
//   presented directly (the original shows the previous frame's page — a
//   1-frame lag with no content difference; likewise fpal is applied the
//   frame it is built instead of on the next copper tick).
// - Camera: SPLINE.ASM getspl at position 4*256+frames*4 over RATA.INC
//   control points (tx,ty,dis,kx,ky,kz,ls_kx,ls_ky — order fixed by
//   getspl's pop sequence) with the 1024-word SPLINE.INC B-spline basis
//   (banks sum to 32768 = unity; assets from tools/extract_plzvect.mjs).
//   `frames` advances by elapsed vblanks (VECT.C:122) → 1 per 70 Hz frame
//   here, rate-immune by construction.
// - count_const/rotate: exact integer semantics incl. the C `>>15+7`
//   precedence quirk (= >>22), 32-bit wraps, int16 wraps, and the
//   truncating projections xxx=xx*256/zz+320, yyy=yy*142/zz+66
//   (VECT.C:188-199).
// - sort_faces (VECT.C:203-246): backface cull via view·normal; per-face
//   light s = (ls·n)/250000+32, geometrically bounded to 0..63 (|ls|≈127
//   unit vector from sinit, |n|≤62500 for 250-unit square faces);
//   shadepal (PLZA.ASM:262-286) rescales the face's 64-colour band
//   pal*shade>>6 into fpal, with the lls[] slot cache preserved (fpal
//   persists across frames, black until a band is first lit).
// - do_poly/do_block (PLZFILL.C:82-176 + PLZA.ASM:59-259): 4-edge walker
//   in 16.16, exact texel stepper (combined ty:tx byte counter with
//   cross-carry, dist1[] row-offset distortion dd=(frames&63)+1, and the
//   x-fraction accumulator seeded from raw addy — ASM's dead [txx1-2]
//   load is clobbered by `mov ecx,eax` before use), spans at byte
//   granularity: interior bytes byteL+1..byteR-1 full 4-pixel width AND
//   the masked left/right edge bytes via the unrolled blocks' fall-through
//   into @@twobyte (PLZA.ASM:167→169) — cnt+1 bytes per span; unsigned
//   span-compare row skip, 134-row bottom clip, and beyond-line-width
//   writes flowing linearly into the next row exactly as in VRAM (writes
//   past the 136-row page buffer are dropped — see writeByte's note; only
//   rows 134-135 are truly spare, but sane spline coords never reach
//   farther).
// - Both plasma fields sample ONE per-frame k/l snapshot; the real render
//   does four plzline passes per frame with moveplz ticking between them,
//   so real k- and l-planes carry slightly different phases (invisible at
//   60fps presentation; documented deviation).
// - Textures/palette procedural (PLZFILL.C:25-68): kuva sine-ridge bands
//   (bands 1/2 = band 0 value + 64/128), dist1 ripple rows, three
//   64-colour bands (blue-white / red-yellow / orange-violet).  do_clear
//   is replaced by a full draw-buffer clear (visually identical: it only
//   reclaims the 3-frame-stale page's spans).
//
// DELIBERATE DEVIATIONS (all invisible or capture-verified, see above):
// interlace jitter omitted; k/l phase at plasma start differs from
// hardware by the unknowable vblanks MAIN.C's initvect() burned before
// the prewait spin; timetable/break polls run per tick (the original's C
// loop polled a few vblanks apart); texture fetches of garbage spans mask
// into the kuva/dist tables instead of reading neighbouring DOS segments;
// unreachable-safety caps as labeled.

const VBLANK_HZ = 70;
// dis_getmframe() real tick rate under plasma render load; capture-measured
// (723 ticks / 13.8 s to the first fall).  See header.
const MFRAME_HZ = 52.4;
const TICKS_PER_FRAME = MFRAME_HZ / VBLANK_HZ;

// PLZ.C:46, in mframe ticks.  The dev tree's 4th entry (2259) is unused:
// shipped EXE + capture show three stages (see header).
const TIMETABLE = [64 * 6 * 2 - 45, 64 * 6 * 4 - 45, 64 * 6 * 5 - 45];
const NUM_STAGES = 3;

// PLZ.C:55-60.  Rows 1..3 are what initpparas loads at the three drops.
const INITTABLE = [
  [1000, 2000, 3000, 4000, 3500, 2300, 3900, 3670],
  [1000, 2000, 4000, 4000, 1500, 2300, 3900, 1670],
  [3500, 1000, 3000, 1000, 3500, 3300, 2900, 2670],
  [1000, 2000, 3000, 4000, 3500, 2300, 3900, 3670],
  [1000, 2000, 3000, 4000, 3500, 2300, 3900, 3670],
  [1000, 2000, 3000, 4000, 3500, 2300, 3900, 3670],
];

// COPPER.ASM:175-181 dtau: linecompare per drop tick (quadratic gravity;
// TASM constant fold of ccc*ccc/4*43/128+60).
const DTAU = new Int32Array(65);
for (let i = 0; i <= 64; i++) DTAU[i] = Math.floor(Math.floor(i * i / 4) * 43 / 128) + 60;

// Unreachable safety caps.  The source has NO caps on these gates; the
// gates themselves are pure musplusFn pass-throughs.
const PREWAIT_SAFETY_FRAMES = 70 * 30;   // nominal wait ~1.4 s
const VECTWAIT_SAFETY_FRAMES = 70 * 30;  // nominal wait ~0.2 s
const VECT_SAFETY_FRAMES = 70 * 120;     // nominal span ~28 s

export const plzpartVram = new Uint8Array(320 * 200);
export const plzpartPal = new Uint8Array(768);

// ---- plasma tables / palettes ----
let seg = null;            // 64K ASMYT segment image: psini | lsini4 | lsini16
let ptau = null;           // 129-byte cosine ramp (PTAU.PRE)
let pals = null;           // Int16Array(6*768): copper deltas after PLZ.C:215-217

// ---- vect tables ----
let sinit = null, splc = null, rata = null;   // extracted assets
let kuva = null, dist1 = null, vpal = null;   // procedural (PLZFILL.C)

// ---- state ----
let localFrame, phase, done, doneAtLocal;
let prewaitFrames, vectwaitFrames;
let tickAcc, mframe, eventsDone, copDrop, copPlz, lineCompare;
let k1, k2, k3, k4, l1, l2, l3, l4;
let il1, il2, il3, il4, ik1, ik2, ik3, ik4;
const fadeAcc = new Uint16Array(768);  // COPPER.ASM fadepal 8.8 accumulator
let fadeDelta = null;                  // current cop_fadepal (Int16 view into pals)
let doPal = false;
const dacPal = new Uint8Array(768);    // last palette uploaded to the DAC (6-bit)
// vect state
let vectFrames = 0;
let vTx = 0, vTy = 0, vDis = 320, vKx = 0, vKy = 0, vKz = 0, vLsKx = 0, vLsKy = 0;
let lsX = 0, lsY = 0, lsZ = 128;
let cxx, cxy, cxz, cyx, cyy, cyz, czx, czy, czz;
const fpal = new Uint8Array(768);
const lls = new Int32Array(6);
const ptXX = new Int32Array(8), ptYY = new Int32Array(8), ptZZ = new Int32Array(8);
const ptSX = new Int32Array(8), ptSY = new Int32Array(8);
let visFaces = [];                     // faces surviving the cull, in face order
const VECT_BYTES = 160 * 136;          // page buffer incl. 2 spare rows (0x5500/160)
const vectPix = new Uint8Array(VECT_BYTES * 4);

const CUBE_PTS = [
  [125, 125, 125], [125, -125, 125], [-125, -125, 125], [-125, 125, 125],
  [125, 125, -125], [125, -125, -125], [-125, -125, -125], [-125, 125, -125],
];
const CUBE_FACES = [           // p1..p4, colour (VECT.C:85-92)
  [1, 2, 3, 0, 0], [7, 6, 5, 4, 0], [0, 4, 5, 1, 1],
  [1, 5, 6, 2, 2], [2, 6, 7, 3, 1], [3, 7, 4, 0, 2],
];
const TXT = [[64, 4], [190, 4], [190, 60], [64, 60]];  // PLZFILL.C:88

const s16 = v => (v << 16) >> 16;
const trunc = (a, b) => Math.trunc(a / b);

function buildPals() {
  // PLZ.C init_plz palette construction, verbatim (pals[2] is "white",
  // pals[3] is "RB-white" — the source fills them out of order).
  pals = new Int16Array(6 * 768);
  const fill = (idx, gen) => {
    let p = idx * 768 + 3;
    gen((r, g, b) => { pals[p++] = r; pals[p++] = g; pals[p++] = b; });
    if (p !== (idx + 1) * 768) throw new Error('pal fill length');
  };
  const t = ptau;
  fill(0, put => {   // RGB
    for (let a = 1; a < 64; a++) put(t[a], t[0], t[0]);
    for (let a = 0; a < 64; a++) put(t[63 - a], t[0], t[0]);
    for (let a = 0; a < 64; a++) put(t[0], t[0], t[a]);
    for (let a = 0; a < 64; a++) put(t[a], t[0], t[63 - a]);
  });
  fill(1, put => {   // RB-black
    for (let a = 1; a < 64; a++) put(t[a], t[0], t[0]);
    for (let a = 0; a < 64; a++) put(t[63 - a], t[0], t[a]);
    for (let a = 0; a < 64; a++) put(t[0], t[a], t[63 - a]);
    for (let a = 0; a < 64; a++) put(t[a], t[63], t[a]);
  });
  fill(3, put => {   // RB-white
    for (let a = 1; a < 64; a++) put(t[a], t[0], t[0]);
    for (let a = 0; a < 64; a++) put(t[63], t[a], t[a]);
    for (let a = 0; a < 64; a++) put(t[63 - a], t[63 - a], t[63]);
    for (let a = 0; a < 64; a++) put(t[0], t[0], t[63]);
  });
  fill(2, put => {   // white (half grey)
    for (let a = 1; a < 64; a++) put(t[0] >> 1, t[0] >> 1, t[0] >> 1);
    for (let a = 0; a < 64; a++) put(t[a] >> 1, t[a] >> 1, t[a] >> 1);
    for (let a = 0; a < 64; a++) put(t[63 - a] >> 1, t[63 - a] >> 1, t[63 - a] >> 1);
    for (let a = 0; a < 64; a++) put(t[0] >> 1, t[0] >> 1, t[0] >> 1);
  });
  fill(4, put => {   // white II (never displayed: break precedes its fade)
    for (let a = 1; a < 75; a++) {
      const v = t[63 - trunc(a * 64, 75)]; put(v, v, v);
    }
    for (let a = 0; a < 106; a++) put(0, 0, 0);
    for (let a = 0; a < 75; a++) {
      const v = t[trunc(a * 64, 75)];
      put(trunc(v * 8, 10), trunc(v * 9, 10), v);
    }
  });
  // PLZ.C:215-217: pals[0] → (v-63)*2 copper deltas (white→target over
  // ~128 ticks); pals[1..4] → v*8 (black→target over ~32 ticks).
  for (let a = 0; a < 768; a++) pals[a] = (pals[a] - 63) * 2;
  for (let a = 768; a < 768 * 5; a++) pals[a] *= 8;
}

function buildVectProcedural() {
  // PLZFILL.C initvect() with C int truncation semantics throughout.
  const sini = new Int32Array(2000);
  for (let a = 0; a < 1524; a++) sini[a] = Math.trunc(Math.sin(a / 1024.0 * Math.PI * 4) * 127);
  kuva = new Uint8Array(16384);      // band 0; bands 1/2 read +64/+128
  for (let y = 0; y < 64; y++) for (let x = 0; x < 256; x++)
    kuva[y * 256 + x] = (trunc(sini[(y * 4 + sini[x * 2]) & 511], 4) + 32) & 255;
  dist1 = new Uint8Array(32768);
  for (let y = 0; y < 128; y++)
    dist1.fill(trunc(sini[y * 8], 3) & 255, y * 256, y * 256 + 256);
  vpal = new Uint8Array(768);        // three 64-colour bands (PLZFILL.C:40-54)
  for (let a = 1; a < 32; a++) vpal[a * 3 + 2] = a * 2;                            // blue ramp
  for (let a = 0; a < 32; a++) {                                                   // blue→white
    vpal[(a + 32) * 3] = a * 2; vpal[(a + 32) * 3 + 1] = a * 2; vpal[(a + 32) * 3 + 2] = 63;
  }
  for (let a = 0; a < 32; a++) vpal[192 + a * 3] = a * 2;                          // black→red
  for (let a = 0; a < 32; a++) {                                                   // red→yellow
    vpal[192 + (a + 32) * 3] = 63; vpal[192 + (a + 32) * 3 + 1] = a * 2;
  }
  for (let a = 0; a < 32; a++) {                                                   // black→orange
    vpal[384 + a * 3] = a; vpal[384 + a * 3 + 2] = trunc(a * 2, 3);
  }
  for (let a = 0; a < 32; a++) {                                                   // orange→violet
    vpal[384 + (a + 32) * 3] = 31 - a; vpal[384 + (a + 32) * 3 + 1] = a * 2;
    vpal[384 + (a + 32) * 3 + 2] = 21;
  }
}

export async function loadPlzpart() {
  const get = async n => new Uint8Array(await (await fetch('assets/' + n)).arrayBuffer());
  const [psB, l4B, l16B, ptB, snB, spB, rtB] = await Promise.all([
    get('plz_psini.bin'), get('plz_lsini4.bin'), get('plz_lsini16.bin'),
    get('plz_ptau.bin'), get('plz_sinit.bin'), get('plz_splinecoef.bin'),
    get('plz_rata.bin')]);
  if (psB.length !== 16384 || l4B.length !== 16384 || l16B.length !== 16384)
    throw new Error('plz table sizes');
  // One 64K image with the exact ASMYT.ASM segment layout, so index
  // arithmetic wraps through neighbouring tables like the real code.
  seg = new Uint8Array(65536);
  seg.set(psB, 0); seg.set(l4B, 0x4000); seg.set(l16B, 0x8000);
  ptau = new Uint8Array(129); ptau.set(ptB.subarray(0, Math.min(129, ptB.length)));
  sinit = new Int16Array(snB.buffer, snB.byteOffset, snB.length >> 1);
  splc = new Int16Array(spB.buffer, spB.byteOffset, spB.length >> 1);
  rata = new Int16Array(rtB.buffer, rtB.byteOffset, rtB.length >> 1);
  if (sinit.length !== 1287 || splc.length !== 1024 || rata.length !== 136 * 8)
    throw new Error('plz vect table sizes');
  buildPals();
  buildVectProcedural();
}

// ---------------------------------------------------------------- plasma --

function moveplz() {   // COPPER.ASM:147-173
  k1 = (k1 - 3) & 4095; k2 = (k2 - 2) & 4095; k3 = (k3 + 1) & 4095; k4 = (k4 + 2) & 4095;
  l1 = (l1 - 1) & 4095; l2 = (l2 - 2) & 4095; l3 = (l3 + 2) & 4095; l4 = (l4 + 3) & 4095;
}

function fadeAccumulate() {  // COPPER.ASM:241-252 (add al / adc ah pairs = 16-bit adds)
  for (let i = 0; i < 768; i++)
    fadeAcc[i] = (fadeAcc[i] + (fadeDelta[i] & 0xFFFF)) & 0xFFFF;
}

function uploadFadepal() {   // copper2 do_pal → 6-bit DAC
  for (let i = 0; i < 768; i++) dacPal[i] = (fadeAcc[i] >> 8) & 63;
}

// One MFRAME_HZ interrupt tick: the C loop's event/break polls folded with
// the copper2 body (do_pal, pompota+moveplz, do_drop).  Returns true when
// the plasma phase ends (PLZ.C:94 break + PLZ.C:119-121 epilogue).
function plasmaTick() {
  // C side: timetable events (PLZ.C:79-93)
  if (eventsDone < NUM_STAGES && mframe > TIMETABLE[eventsDone]) {
    for (let i = 0; i < 768; i++) fadeAcc[i] &= 0x00FF;  // memset(fadepal,0,768): high bytes only
    copDrop = 1;
    fadeDelta = pals.subarray((eventsDone + 1) * 768, (eventsDone + 2) * 768); // pals[curpal++]
    const tb = INITTABLE[eventsDone + 1];                 // ttptr++ → inittable[ttptr]
    il1 = tb[0]; il2 = tb[1]; il3 = tb[2]; il4 = tb[3];
    ik1 = tb[4]; ik2 = tb[5]; ik3 = tb[6]; ik4 = tb[7];
    eventsDone++;
  }
  // C side: break (PLZ.C:94) — cop_drop=0, then one vblank on which the
  // copper only uploads the staged black palette; set_plzstart(500) blanks
  // the split; cop_plz=0 stops pompota/moveplz.
  if (eventsDone === NUM_STAGES && copDrop > 64) {
    copDrop = 0;
    if (doPal) { uploadFadepal(); doPal = false; }
    moveplz();               // cop_plz still on during the wait frame
    lineCompare = 500;
    copPlz = 0;
    mframe++;
    return true;
  }
  // copper2 body
  if (doPal) { uploadFadepal(); doPal = false; }
  if (copPlz) { lineCompare = 60; moveplz(); }            // pompota (phase 0) + moveplz
  if (copDrop !== 0) {                                    // do_drop
    copDrop++;
    if (copDrop <= 64) {
      lineCompare = DTAU[copDrop];
    } else if (copDrop >= 256) {
      copDrop = 0;
    } else if (copDrop >= 128 || copDrop <= 96) {         // @@lll
      doPal = true;
      if (copDrop === 65) {                               // @@l5
        lineCompare = 400;
        l1 = il1; l2 = il2; l3 = il3; l4 = il4;           // initpparas
        k1 = ik1; k2 = ik2; k3 = ik3; k4 = ik4;
      } else {
        lineCompare = 60;
        fadeAccumulate();
      }
    } else {                                              // 97..127: @@end
      copDrop = 0;
    }
  }
  mframe++;
  return false;
}

// ASMYT.ASM plzline field byte with exact segment-offset wrap.
function fieldByte(n, y, c1, c2, c3, c4) {
  const oA = (0x8000 + 2 * y + 2 * c2 + 640 - 8 * n) & 0xFFFF;
  const bxA = seg[oA] | (seg[(oA + 1) & 0xFFFF] << 8);
  const a = seg[(bxA + c1 + 8 * n) & 0xFFFF];
  const oB = (0x4000 + 2 * y + 2 * c4 + 32 * n) & 0xFFFF;
  const bxB = seg[oB] | (seg[(oB + 1) & 0xFFFF] << 8);
  const b = seg[(bxB + 2 * y + c3 + 320 - 4 * n) & 0xFFFF];
  return (a + b) & 255;
}

const rowK = new Uint8Array(80), rowL = new Uint8Array(80);
// Rendered at the mode's NATIVE 320x400.
//
// The plasma runs in tw_opengraph2's 320x400 unchained mode, and the k/l
// checkerboard is one screen pixel in BOTH axes: pixel(x,line) shows the
// k-field when (x+line)&1, else the l-field. A 320x200 frame sampled at
// scanline 2r and line-doubled would fix the line parity at even for every row —
// the k and l fields would fall into fixed 1px-wide vertical columns two screen
// rows tall, a hard, static, high-contrast dither instead of a 1x1 checker.
// Emitting all 400 scanlines reproduces the real raster directly: adjacent rows
// genuinely alternate phase, and the fields interleave into the fine even
// texture the capture shows. It also removes the reason the interlace jitter
// mattered —
// COPPER.ASM's pompota one-line/half-pixel dither exists to soften exactly this
// checker on a 70 Hz CRT, and at native resolution there is nothing left for it
// to soften (per-frame jitter is still not reproduced: a 60 fps browser would
// alias it into irregular flicker rather than blend it).
export const plzpartVram400 = new Uint8Array(320 * 400);
function renderPlasma() {
  const LC = lineCompare;
  for (let s = 0; s < 400; s++) {
    const p = s - LC;
    const out = s * 320;
    if (s < LC || p >= 280) { plzpartVram400.fill(0, out, out + 320); continue; }
    for (let n = 0; n < 80; n++) {
      rowK[n] = fieldByte(n, p, k1, k2, k3, k4);
      rowL[n] = fieldByte(n, p, l1, l2, l3, l4);
    }
    // PLZ.C:96-117 writes the k-field and l-field to complementary plane pairs
    // (map mask 0Ah/05h) and swaps them on odd lines, so within a 4-pixel byte
    // the two fields land on alternating pixels, phase set by the line parity.
    const odd = p & 1;
    for (let n = 0; n < 80; n++) {
      const kv = rowK[n], lv = rowL[n], o = out + n * 4;
      if (odd) {
        plzpartVram400[o] = kv; plzpartVram400[o + 1] = lv;
        plzpartVram400[o + 2] = kv; plzpartVram400[o + 3] = lv;
      } else {
        plzpartVram400[o] = lv; plzpartVram400[o + 1] = kv;
        plzpartVram400[o + 2] = lv; plzpartVram400[o + 3] = kv;
      }
    }
  }
}

function presentPlasma() {
  renderPlasma();
  plzpartPal.set(dacPal);
}

// ------------------------------------------------------------------ vect --

function kosinit(i) { return sinit[i + 256]; }  // INCLUDE.ASM: kosinit=sinit+512 (bytes)

function getspl(pos) {   // SPLINE.ASM
  let cpi = pos >> 8;
  const frac = pos & 255;
  if (cpi > 132) cpi = 132;   // unreachable safety: exit ~frame 2000 → cpi ~35 of 136
  const o = new Int32Array(8);
  for (let j = 0; j < 8; j++) {
    const sum = rata[(cpi + 3) * 8 + j] * splc[frac] +
      rata[(cpi + 2) * 8 + j] * splc[frac + 256] +
      rata[(cpi + 1) * 8 + j] * splc[frac + 512] +
      rata[cpi * 8 + j] * splc[frac + 768];
    o[j] = s16((sum << 1) >> 16);   // shld cx,bx,1 → int16 of sum>>15
  }
  vTx = o[0]; vTy = o[1]; vDis = o[2];
  vKx = o[3]; vKy = o[4]; vKz = o[5];
  vLsKx = o[6]; vLsKy = o[7];
}

function vectCalculate() {   // VECT.C calculate()+count_const()+rotate()+sort_faces()
  getspl(4 * 256 + vectFrames * 4);
  vKx &= 1023; vKy &= 1023; vKz &= 1023; vLsKx &= 1023; vLsKy &= 1023;
  lsY = kosinit(vLsKx) >> 8;
  lsX = ((sinit[vLsKx] >> 8) * (sinit[vLsKy] >> 8)) >> 7;
  lsZ = ((sinit[vLsKx] >> 8) * (kosinit(vLsKy) >> 8)) >> 7;

  const SX = sinit[vKx], SY = sinit[vKy], SZ = sinit[vKz];
  const CX = kosinit(vKx), CY = kosinit(vKy), CZ = kosinit(vKz);
  // C `>>15+7` parses as >>22; 32-bit wrap via |0.
  cxx = ((CY * CZ) | 0) >> 22;
  cxy = ((CY * SZ) | 0) >> 22;
  cxz = (-SY) >> 7;
  cyx = ((((SX * CZ + 16384) >> 15) * SY - CX * SZ) | 0) >> 22;
  cyy = ((((SX * SY + 16384) >> 15) * SZ + CX * CZ) | 0) >> 22;
  cyz = ((CY * SX) | 0) >> 22;
  czx = ((((CX * CZ + 16384) >> 15) * SY + SX * SZ) | 0) >> 22;
  czy = ((((CX * SY + 16384) >> 15) * SZ - SX * CZ) | 0) >> 22;
  czz = ((CY * CX) | 0) >> 22;

  for (let a = 0; a < 8; a++) {     // rotate(): int16 semantics
    const [x, y, z] = CUBE_PTS[a];
    ptXX[a] = s16(s16(s16(s16(s16(x * cxx) >> 1) + s16(s16(y * cxy) >> 1) + s16(s16(z * cxz) >> 1)) >> 7) + vTx);
    ptYY[a] = s16(s16(s16(s16(s16(x * cyx) >> 1) + s16(s16(y * cyy) >> 1) + s16(s16(z * cyz) >> 1)) >> 7) + vTy);
    ptZZ[a] = s16(s16(s16(s16(s16(x * czx) >> 1) + s16(s16(y * czy) >> 1) + s16(s16(z * czz) >> 1)) >> 7) + vDis);
    const d = ptZZ[a] === 0 ? 1 : ptZZ[a];   // div-by-zero guard (unreachable: dis>=300)
    ptSX[a] = s16(trunc(ptXX[a] * 256, d) + 320);
    ptSY[a] = s16(trunc(ptYY[a] * 142, d) + 66);
  }

  visFaces.length = 0;
  let p = 0;
  for (let f = 0; f < 6; f++) {     // sort_faces()
    const [p1, p2, p3, , color] = CUBE_FACES[f];
    const x = ptXX[p1], y = ptYY[p1], z = ptZZ[p1];
    const ax = ptXX[p2] - x, ay = ptYY[p2] - y, az = ptZZ[p2] - z;
    const bx = ptXX[p3] - x, by = ptYY[p3] - y, bz = ptZZ[p3] - z;
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    if (-x * nx - y * ny - z * nz > 0) continue;      // backface
    const shade = trunc(lsX * nx + lsY * ny + lsZ * nz, 250000) + 32;
    if (lls[p] !== shade) {                            // shadepal slot cache
      for (let i = 0; i < 192; i++)
        fpal[color * 192 + i] = ((vpal[color * 192 + i] * (shade & 255)) >> 6) & 255;
      lls[p] = shade;
    }
    visFaces.push(f);
    p++;
  }
}

const START_MASK = [0b1111, 0b1110, 0b1100, 0b1000];
const END_MASK = [0b0001, 0b0011, 0b0111, 0b1111];

function writeByte(addr, val, mask) {
  // Out-of-buffer writes are dropped. On real VRAM an address >= 0x5500
  // lands in the NEXT PAGE (displayed 1-2 frames later), not in spare rows
  // (only 134-135 are spare) — unreachable for sane spline coordinates
  // (max span cpi keeps the cube on-screen), so drop-vs-corrupt never fires.
  if (addr < 0 || addr >= VECT_BYTES) return;
  const o = addr * 4;
  if (mask & 1) vectPix[o] = val;
  if (mask & 2) vectPix[o + 1] = val;
  if (mask & 4) vectPix[o + 2] = val;
  if (mask & 8) vectPix[o + 3] = val;
}

// PLZA.ASM do_block texel fetch: bx = (ty<<8)|tx combined counter, dist1
// row-offset lookup, then the displaced kuva fetch (masks keep garbage
// spans inside the tables; legit addresses never exceed them).
function texel(bx, distOfs, colorAdd) {
  const si = dist1[(distOfs + bx) & 0x7FFF];
  return (kuva[(bx + si) & 0x3FFF] + colorAdd) & 255;
}

// One textured quad: VECT.C draw() → PLZFILL.C do_poly() → PLZA.ASM do_block().
function doPoly(x1, y1, x2, y2, x3, y3, x4, y4, color, dd) {
  dd = (dd + 1) & 63;
  const distOfs = dd * 256;
  const colorAdd = color === 1 ? 64 : color === 2 ? 128 : 0;
  const px = [x1, x2, x3, x4], py = [y1, y2, y3, y4];
  let n = 0;
  for (let a = 1; a < 4; a++) if (py[a] < py[n]) n = a;   // topmost, first of ties
  let s1 = n, s2 = n, d1 = (s1 + 1) & 3, d2 = (s2 - 1) & 3;
  let ax1, xx1, txx1, txy1, tax1, tay1;
  let ax2, xx2, txx2, txy2, tax2, tay2;
  const setEdge1 = () => {
    const dx = px[d1] - px[s1]; let dy = py[d1] - py[s1]; if (dy === 0) dy++;
    ax1 = Math.trunc(65536 * dx / dy) | 0;
    xx1 = ((px[s1] << 16) + 0x8000) | 0;
    txx1 = ((TXT[s1][0] << 16) + 0x8000) | 0;
    txy1 = ((TXT[s1][1] << 16) + 0x8000) | 0;
    tax1 = Math.trunc(65536 * (TXT[d1][0] - TXT[s1][0]) / dy) | 0;
    tay1 = Math.trunc(65536 * (TXT[d1][1] - TXT[s1][1]) / dy) | 0;
  };
  const setEdge2 = () => {
    const dx = px[d2] - px[s2]; let dy = py[d2] - py[s2]; if (dy === 0) dy++;
    ax2 = Math.trunc(65536 * dx / dy) | 0;
    xx2 = ((px[s2] << 16) + 0x8000) | 0;
    txx2 = ((TXT[s2][0] << 16) + 0x8000) | 0;
    txy2 = ((TXT[s2][1] << 16) + 0x8000) | 0;
    tax2 = Math.trunc(65536 * (TXT[d2][0] - TXT[s2][0]) / dy) | 0;
    tay2 = Math.trunc(65536 * (TXT[d2][1] - TXT[s2][1]) / dy) | 0;
  };
  setEdge1(); setEdge2();
  let yy = py[s1];
  let stopped = false;

  const doBlock = (count) => {   // PLZA.ASM do_block
    for (let row = 0; row < count && !stopped; row++) {
      if (yy >= 134) { stopped = true; break; }   // @@end: hard stop, no advance
      if (yy >= 0) {
        const xLu = (xx2 >> 16) & 0xFFFF, xRu = (xx1 >> 16) & 0xFFFF;
        const byteL = xLu >>> 2, byteR = xRu >>> 2;
        const cnt = byteR - byteL;                 // jb @@endline on unsigned borrow
        const base = yy * 160;
        if (cnt === 0) {                           // @@singlebyte
          const m = START_MASK[xLu & 3] & END_MASK[xRu & 3];
          const bx = (((txy2 >> 16) & 255) << 8) | ((txx2 >> 16) & 255);
          writeByte(base + byteL, texel(bx, distOfs, colorAdd), m);
        } else if (cnt === 1) {                    // @@twobyte
          const bx2 = (((txy2 >> 16) & 255) << 8) | ((txx2 >> 16) & 255);
          writeByte(base + byteL, texel(bx2, distOfs, colorAdd), START_MASK[xLu & 3]);
          const bx1 = (((txy1 >> 16) & 255) << 8) | ((txx1 >> 16) & 255);
          writeByte(base + byteL + 1, texel(bx1, distOfs, colorAdd), END_MASK[xRu & 3]);
        } else if (cnt >= 2) {
          // main path: interior bytes byteL+1..byteR-1 (texel k → byte
          // byteR-1-k, exact register stepper), then the unrolled blocks
          // FALL THROUGH into @@twobyte (PLZA.ASM:167→169, byte-verified in
          // PLZA.OBJ: jmp_tau[0]=0x2438 = the @@twobyte code), which adds
          // the masked LEFT edge byte (txx2/txy2 texel) and RIGHT edge byte
          // (txx1/txy1 texel) — cnt+1 bytes total, pixel-precise edges.
          const esi = cnt - 1;
          const addy = Math.trunc((txy2 - txy1) / esi) | 0;
          const addx = Math.trunc((txx2 - txx1) / esi) | 0;
          // rol eax,16: eax = (xfrac<<16) | xint16
          const eax = ((((addx & 0xFFFF) << 16) >>> 0) + ((addx >>> 16) & 0xFFFF)) >>> 0;
          // edx = (yfrac<<16) | (dh=yint.low, dl=xint.low), dec dh if dl<0
          let dh0 = (addy >>> 16) & 0xFF;
          const dl0 = (addx >>> 16) & 0xFF;
          if (dl0 & 0x80) dh0 = (dh0 - 1) & 0xFF;
          const edx = ((((addy & 0xFFFF) << 16) >>> 0) + ((dh0 << 8) | dl0)) >>> 0;
          // ecx starts as raw addy: PLZA.ASM:103's load of [txx1-2] is DEAD,
          // clobbered by :110 `mov ecx,eax` right after the addy idiv
          // (byte-verified @0x267f in PLZA.OBJ / @0x6b0c in the shipped
          // image). Only its carry-outs matter, but they must match.
          let ecx = addy >>> 0;
          // ebx = (yfrac accumulator << 16) | (ty.low<<8 | tx.low)
          let ebx = ((((txy1 & 0xFFFF) << 16) >>> 0) +
            ((((txy1 >>> 16) & 0xFF) << 8) | ((txx1 >>> 16) & 0xFF))) >>> 0;
          for (let k = 0; k <= cnt - 2; k++) {
            writeByte(base + byteL + cnt - 1 - k, texel(ebx & 0xFFFF, distOfs, colorAdd), 0b1111);
            let t = ecx + eax; const c1 = t >= 4294967296 ? 1 : 0; ecx = t >>> 0;
            t = ebx + edx + c1; const c2 = t >= 4294967296 ? 1 : 0; ebx = t >>> 0;
            if (c2) ebx = ((ebx & 0xFFFF00FF) | ((((ebx >>> 8) + 1) & 0xFF) << 8)) >>> 0; // adc bh,0
          }
          // @@twobyte fall-through: masked edge bytes at byteL and byteR
          const bxL = (((txy2 >> 16) & 255) << 8) | ((txx2 >> 16) & 255);
          writeByte(base + byteL, texel(bxL, distOfs, colorAdd), START_MASK[xLu & 3]);
          const bxR = (((txy1 >> 16) & 255) << 8) | ((txx1 >> 16) & 255);
          writeByte(base + byteL + cnt, texel(bxR, distOfs, colorAdd), END_MASK[xRu & 3]);
        }
        // cnt < 0 (unsigned borrow): row skipped entirely
      }
      // @@endline: advance edge/texture accumulators
      yy++;
      xx1 = (xx1 + ax1) | 0; xx2 = (xx2 + ax2) | 0;
      txy1 = (txy1 + tay1) | 0; txx1 = (txx1 + tax1) | 0;
      txy2 = (txy2 + tay2) | 0; txx2 = (txx2 + tax2) | 0;
    }
  };

  for (let e = 0; e < 4 && !stopped;) {   // do_poly edge chain
    const m = Math.min(py[d1], py[d2]);
    doBlock(m - yy);
    yy = m;
    if (py[d1] === py[d2]) {
      s1 = d1; d1 = (s1 + 1) & 3; s2 = d2; d2 = (s2 - 1) & 3; e += 2;
      setEdge1(); setEdge2();
    } else if (py[d1] < py[d2]) {
      s1 = d1; d1 = (s1 + 1) & 3; e++; setEdge1();
    } else {
      s2 = d2; d2 = (s2 - 1) & 3; e++; setEdge2();
    }
  }
}

function renderVect() {
  vectPix.fill(0);
  for (const f of visFaces) {
    const [p1, p2, p3, p4, color] = CUBE_FACES[f];
    doPoly(ptSX[p1], ptSY[p1], ptSX[p2], ptSY[p2],
      ptSX[p3], ptSY[p3], ptSX[p4], ptSY[p4], color, vectFrames & 63);
  }
  // visible window: the CRTC fetches 80 consecutive byte addresses from
  // start byte 40 of each 160-byte row = buffer pixels 160..479, shown
  // 1:1 as the 320 dots (this is also what makes the 256:142 projection
  // scale square on a 4:3 raster).  Row = floor(2r/3) (3-scan rows on the
  // 400-line raster; planar addr*4+plane ≡ row*640+x).
  for (let r = 0; r < 200; r++) {
    const src = ((2 * r / 3) | 0) * 640 + 160;
    const out = r * 320;
    plzpartVram.set(vectPix.subarray(src, src + 320), out);
  }
  for (let i = 0; i < 768; i++) plzpartPal[i] = fpal[i] & 63;
}

// ------------------------------------------------------------ state/step --

export function plzpartReset() {
  localFrame = -1; phase = 'prewait'; done = false; doneAtLocal = null;
  prewaitFrames = 0; vectwaitFrames = 0;
  tickAcc = 0; mframe = 0; eventsDone = 0; copDrop = 128; copPlz = 1; lineCompare = 60;
  l1 = 1000; l2 = 2000; l3 = 3000; l4 = 4000;      // PLZ.C:49-50
  k1 = 3500; k2 = 2300; k3 = 3900; k4 = 3670;
  il1 = 1000; il2 = 2000; il3 = 3000; il4 = 4000;  // PLZ.C:52-53
  ik1 = 3500; ik2 = 2300; ik3 = 3900; ik4 = 3670;
  fadeAcc.fill(0x3F00);           // white start (see header: fadepal entry state)
  fadeDelta = pals ? pals.subarray(0, 768) : null;  // cop_fadepal = pals[0]
  doPal = false;
  dacPal.fill(63);                // init_plz: whole DAC white (PLZ.C:179)
  vectFrames = 0;
  fpal.fill(0); lls.fill(0); visFaces.length = 0;
  plzpartVram.fill(0);
  plzpartVram400.fill(0);
  plzpartPal.fill(63);            // entry seam is white
}

export function plzpartEnded() { return done; }
// the plasma runs natively in a 320x400 mode; vect is 320x200 line-doubled
export function plzpartMode400() { return phase === 'plasma'; }
export function plzpartLocalFrames() { return localFrame; }
export function plzpartDurationS() {
  if (doneAtLocal != null) return doneAtLocal;
  return Math.max(0, localFrame) / VBLANK_HZ;
}

export function plzpartStepTo(tt, replay, musplusFn) {
  if (done) return false;
  const target = Math.floor(tt * VBLANK_HZ);
  let steps = target - localFrame;
  if (steps <= 0) return true;
  if (steps > 35 && !replay) steps = 35;
  let needPaint = false;
  for (let s = 0; s < steps && !done; s++) {
    localFrame++;
    const last = (s === steps - 1);
    const m = musplusFn ? musplusFn(localFrame / VBLANK_HZ) : -32;

    if (phase === 'prewait') {
      // PLZ.C:68 while(dis_musplus()<0).  Copper already installed:
      // moveplz runs at the full 70 Hz (no render load yet).
      moveplz();
      prewaitFrames++;
      if (m < 0 && prewaitFrames < PREWAIT_SAFETY_FRAMES) continue;
      phase = 'plasma';       // dis_setmframe(0); init_plz(); cop_drop=128
      tickAcc = 0; mframe = 0; copDrop = 128;
      needPaint = true;
      if (last) { presentPlasma(); needPaint = false; }
      continue;
    }
    if (phase === 'plasma') {
      tickAcc += TICKS_PER_FRAME;   // interrupt chain at MFRAME_HZ under render load
      let ended = false;
      while (tickAcc >= 1 && !ended) { tickAcc -= 1; ended = plasmaTick(); }
      if (ended) {
        phase = 'plasmawait';       // PLZ.C:119 frame_count wait
        plzpartVram.fill(0);        // linecompare 400/500: colour 0 everywhere
        plzpartVram400.fill(0);
        plzpartPal.set(dacPal);     // staged black upload landed in plasmaTick
        needPaint = false;
        continue;
      }
      needPaint = true;
      if (last) { presentPlasma(); needPaint = false; }
      continue;
    }
    if (phase === 'plasmawait') {   // then vect(): tw_opengraph clears vmem
      phase = 'vectwait'; vectwaitFrames = 0;
      continue;
    }
    if (phase === 'vectwait') {
      // VECT.C:116 while(dis_musplus()<13).  Black screen (cleared vmem,
      // last-uploaded black fadepal).
      vectwaitFrames++;
      if (m < 13 && vectwaitFrames < VECTWAIT_SAFETY_FRAMES) continue;
      phase = 'vect';
      continue;
    }
    if (phase === 'vect') {
      // VECT.C:119-120 exit — every frame, replay included.
      if (m >= -4 && m < 0) { done = true; doneAtLocal = localFrame / VBLANK_HZ; break; }
      if (vectFrames >= VECT_SAFETY_FRAMES) {   // unreachable-safety only
        done = true; doneAtLocal = localFrame / VBLANK_HZ; break;
      }
      vectFrames++;                 // frames += frame_count (1 per vblank)
      vectCalculate();              // fpal/lls state must evolve every frame
      needPaint = true;
      if (last) { renderVect(); needPaint = false; }
      continue;
    }
  }
  if (!done && needPaint) {
    if (phase === 'plasma') presentPlasma();
    else if (phase === 'vect') renderVect();
  }
  return !done;
}
