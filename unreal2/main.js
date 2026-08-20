// Second Reality — INTRO / "Alkutekstit I" (ALKU.EXE), browser port
// Faithful port of ALKU/MAIN.C + TWEAK.ASM + COPPER.ASM + ASMYT.ASM.
// Original source is public domain (Unlicense, 2013 anniversary release).
//
// The intro: three centered title cards fade in/out ("A Future Crew
// Production" / "First presented at Assembly 93" / "in <Dolby Surround>"),
// then a wide starfield+mountain panorama (HOI) scrolls horizontally while
// the credits (Graphics/Music/Code/Additional Design) fade in and scroll.
//
// Engine notes (matching the original):
//  - VGA "tweak" mode: unchained planar 320-wide window over a 704-wide
//    virtual canvas; here a flat chunky indexed framebuffer (px = y*FBW+x,
//    exactly the planar (x>>2)+y*176 layout flattened to 4*176=704 wide).
//  - the "copper" (DIS interrupt server) does, in the vblank: hardware
//    horizontal scroll (display-start + pixel-pan), palette upload, and an
//    incremental palette-fade accumulator. All reproduced here per vframe.
//  - text is a 2-bit FONA font; a text pixel adds 0x40/0x80/0xC0 to the
//    background index, landing in a tinted copy of the palette, so text is a
//    semi-transparent tint that fades purely by animating the palette.
//  - music = MUSIC0.S3M ("UnreaL ][") — the scrambled repo file, descrambled
//    in-browser (see s3msim.js's descramble()); timeline driven by a 70 Hz
//    virtual vblank clock anchored to the audio clock, gated by dis_sync()
//    music sections.
//  - display window: 320x400 (the tweaked mode shows 400 rows filling the 4:3
//    raster); U2A is 320x200 double-scanned into the same 400-row view, so the
//    two parts land pixel-identically on screen.

// version queries defeat the dev server's heuristic module caching
import { descramble, buildTimeline, musplusAtTime, loaderGateEndTime, rowAtTime }
  from './s3msim.js?v=3';
import { loadU2A, u2aReset, u2aStep, u2aRender, u2aAllOff, u2aPalette as u2aPalRef } from './u2a.js?v=12';
import { loadPam, pamFrames, pamPal, logoPix, logoPal } from './pam.js?v=12';
import { loadGlenz, glenzReset, glenzStepTo, glenzVram, glenzIntroVram, glenzDac,
         glenzMode400, music1Bytes } from './glenz.js?v=13';
import { loadTunnel, tunnelReset, tunnelStepTo, tunnelVram, tunnelPal } from './tunnel.js?v=12';
import { loadDdstars, ddstarsReset, ddstarsStepTo, ddstarsVram, ddstarsPal } from './ddstars.js?v=1';
import { loadTechno, technoReset, technoStepTo, technoVram, technoVram400, technoPal,
         technoMode400, technoEnded, technoEndFrames } from './techno.js?v=24';
import { loadMntscrl, mntscrlReset, mntscrlStepTo, mntscrlVram, mntscrlPal, mntscrlEnded,
         mntscrlDurationS } from './mntscrl.js?v=6';
import { loadLnszoom, lnszoomReset, lnszoomStepTo, lnszoomVram, lnszoomVram400, lnszoomPal,
         lnszoomMode400, lnszoomEnded, lnszoomDurationS } from './lnszoom.js?v=8';
import { loadPanic, panicReset, panicStepTo, panicVram, panicPal, panicEnded,
         panicEndFrames } from './panic.js?v=5';
import { loadPlzpart, plzpartReset, plzpartStepTo, plzpartVram, plzpartVram400, plzpartPal,
         plzpartEnded, plzpartMode400, plzpartDurationS } from './plzpart.js?v=9';
import { loadMinvball, minvballReset, minvballStepTo, minvballVram, minvballPal, minvballEnded,
         minvballDurationS } from './minvball.js?v=6';
import { loadRayscrl, rayscrlReset, rayscrlStepTo, rayscrlVram, rayscrlPal, rayscrlEnded,
         rayscrlDurationS } from './rayscrl.js?v=6';
import { loadSinfield, sinfieldReset, sinfieldStepTo, sinfieldVram, sinfieldPal, sinfieldEnded,
         sinfieldDurationS } from './sinfield.js?v=6';
import { loadJplogo, jplogoReset, jplogoStepTo, jplogoVram, jplogoPal, jplogoEnded, jplogoMode400,
         jplogoDurationS } from './jplogo.js?v=8';
import { loadU2e, u2eReset, u2eStepTo, u2eVram, u2eVram400, u2ePal, u2eMode400,
         u2eEnded, u2eDurationS }
  from './u2e.js?v=4';
import { loadEndlogo, endlogoReset, endlogoStepTo, endlogoVram, endlogoPal, endlogoEnded, endlogoMode400,
         endlogoDurationS } from './endlogo.js?v=4';
import { loadCred, credReset, credStepTo, credVram, credPal, credEnded, credDurationS }
  from './cred.js?v=3';
import { loadEndscrl, endscrlReset, endscrlStepTo, endscrlVram, endscrlPal, endscrlEnded } from './endscrl.js?v=4';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const VBLANK_HZ = 70;
// U2A ("Alkutekstit II", the spaceship flyby) runs after ALKU's scroll stops.
// Start = the demo's own music gate: U2A.C polls the DIS server until
// orderpos > 10 && row > 46, first true at orderpos 11 row 47 = 93.875s in
// the PATCHED module. That puts the three escort drones (anim frame 259) at
// 97.58s — dead on the composer's "HyperSpace Swoosh" note pair at
// 97.50/97.75 in patched-module time.
// TIMEBASE: every MUSIC0-era constant below is
// in PATCHED-module time. STARTMUS.C's byte-50 patch (125→120 BPM, applied
// to playback since ) stretches the whole module by exactly 25/24
// (single constant tempo, verified via s3msim on both variants) — the old
// constants matched the UNPATCHED module, leaving intro-era visuals ~4.2%
// ahead of the audio (~3.8s by the drone pass). Old value × 25/24 = new.
const U2A_START = 93.875;   // gate ord11 row47, patched-module time (was 90.12 unpatched)
const U2A_ABORT_S = 102.875;   // U2A.C's in-loop `a>11&&b>54` abort: ord12 row55
// PAM ("Alkutekstit III") — the moon explosion FLI: white flash at part start,
// 40 anim frames at one per 4 vblanks (17.5 fps), fading back to white; then
// BEG fades the SECOND REALITY title in from white.
// Timing is not a measurement at all — PAM/OUTTAA.C:39 opens with a real gate,
// `while(dis_sync()<10&&!dis_exit());`, and section 10's ordersync1 key is
// 0x0d00 (order 13, row 0). By sync_10's strictly-after rule (see SYNC_S) the
// first position reporting 10 is order 13 ROW 1 = 104.125s patched, one row
// after the 104.0 the old measured constant used. That the "Praxis HyperSpace
// Blast" notes sit right there is the composer choreographing to the gate, not
// the other way round.
// (literal, not SYNC_S[10] — SYNC_S is declared further down this file)
const PAM_START = 104.125;   // ord13 row1, patched-module time (was 104.0, one row early)
// PAM/OUTTAA.C's main() is a flat `while(!dis_exit()&&f++<45){while(frame_
// count<4);frame_count=0;...}` loop -- exactly 45*4=180 vblanks, confirmed
// directly against source, no trailing hold before close_copper(). BEG_START
// (when BEG.EXE itself begins) assumes zero EXE chain-load latency between
// parts -- a real DOS-hardware fact with no source-code representation, so
// this is the best available estimate, not a fully certain derivation (the
// same caveat applies to every other *_START constant in this file that
// marks a chain-loaded EXE's start). BEG/BEG.C's own main() opens with a
// real, previously-unmodeled `for(a=0;a<32;a++) dis_waitb();` hold (screen
// cleared to a flat DAC-index-15 fill, palette not yet touched -- since PAM
// ends fully white, holding on BEG's own natural begC=0 starting state for
// this window is a faithful low-risk approximation) before the picture is
// even blitted; BEG_FADE_START below marks where the real 129-step
// (`for(c=0;c<=128;c++)`) fade actually begins.
const PAM_ANIM_FRAMES = 40;   // OUTTAA.C blits only while f<=40
const PAM_END = PAM_START + 180 / VBLANK_HZ;
const BEG_START = PAM_END;
const BEG_PREHOLD_FRAMES = 32;
const BEG_FADE_START = BEG_START + BEG_PREHOLD_FRAMES / VBLANK_HZ;
// GLENZ / the MUSIC1 switch — DERIVED FROM THE LOADER, not measured.
//
// The demo doesn't decide this with any music gate. MAIN/U2.ASM:810-820 reads:
//     mov si,OFFSET exe3   / call partexecute      ; BEGLOGO runs
//     test cs:whattorun,1  / jz @@skip2b
//     mov ax,1 / mov bx,0 / mov cx,48700 / call restartmus   ; MUSIC1 STARTS
//     mov si,OFFSET exe4   / call partexecute      ; GLENZ runs
// — the LOADER starts MUSIC1 (module 1, order 0), not GLENZ.EXE, the instant
// BEGLOGO's main() returns. So the switch time is simply the sum of the parts'
// own source-coded vblank counts, the same way every other chain-loaded
// *_START constant in this file is built:
//     PAM_START            104.125   (OUTTAA.C's `while(dis_sync()<10)` gate)
//   + PAM   180 vblanks      2.5714   (`f++<45`, 4 vblanks each)
//   + BEG    32 vblanks      0.4571   (`for(a=0;a<32;a++) dis_waitb()`)
//   + BEG   129 vblanks      1.8429   (`for(c=0;c<=128;c++)`, one dis_waitb each)
//   = 108.996
// BEG.C contains no other dis_waitb: the vram memsets, the 400-row readp/
// lineblit picture decode and the DAC writes are untimed CPU work, and
// restartmus itself is disk I/O (it chain-loads the module via exemus). Like
// every other *_START here, this therefore assumes zero EXE chain-load latency
// — real DOS-hardware time with no source representation. That is the one
// remaining unknown, and it can only make the true value LATER, never earlier.
// (The capture, corrected for its own ~1% rate error, puts the switch near
// 109.6, i.e. ~0.6s of chain-load latency. Consistent, but not derivable, so
// not used.)
//
// The glenz part opens on the held SECOND REALITY title — a pixel-identical
// hand-off — then its zoomer2 wipe tears it away 6.52s in. Part end: glenz's
// MAIN loop starts at its vframe 333 and exits at loop frame 2267, i.e. music1
// time MFRAME0_S + (333+2267)/70 (the demo's own musplus gate, 15 rows before
// the second +++ marker). TUNNEL_START is that, expressed off GLENZ_START, so
// the two stay locked together instead of being independently rounded.
const BEG_FADE_FRAMES = 129;              // BEG.C `for(c=0;c<=128;c++)`
const GLENZ_START = BEG_FADE_START + BEG_FADE_FRAMES / VBLANK_HZ;   // = 108.996
const GLENZ_MFRAME0_S = 6.5187;           // glenz.js MFRAME0_S (MUSIC1 ord2 row45)
const GLENZ_END_MUSIC1 = GLENZ_MFRAME0_S + (333 + 2267) / VBLANK_HZ; // = 43.6616
const TUNNEL_START = GLENZ_START + GLENZ_END_MUSIC1;                 // = 152.658
// TECHNO.EXE starts immediately after TUNNELI (veke=1060). No source basis
// for an extra gap, so there is none.
const TECHNO_START = TUNNEL_START + 1060 / VBLANK_HZ;
// Transport-label estimates only. Live cascade uses phase-local clocks
// (panicT0 / mntscrlT0 / ... / endscrlT0) set at each real transition — see
// tick(). They agree with the reference capture at every video-checkable
// boundary (MNTSCRL ~231, LNS&ZOOM ~259.8, PLZPART exit 372.5, MINVBALL
// whiteout ~409.4, JPLOGO ~468, U2E wash-in ~479-480).
//
// REGENERATE (do this whenever any part's duration logic changes — the labels
// are a snapshot of the T0 chain, not an input to it):
//     node tools/harness/shot.js \
//       "http://localhost:8094/?silent&jump=660&phaselog" 60000 /tmp/p.png /tmp/p.log
//     grep 'live T0 chain' /tmp/p.log
// and paste the reported values here.
const PANIC_START = 224.272;
const MNTSCRL_START = 231.189;
const LNSZOOM_START = 260.274;
const PLZPART_LBL = 305.703;
const MINVBALL_LBL = 373.003;
const RAYSCRL_LBL = 409.860;
const SINFIELD_LBL = 439.346;
const JPLOGO_LBL = 468.432;
const U2E_LBL = 479.689;
const ENDLOGO_LBL = 535.374;
const CRED_LBL = 543.989;
const ENDSCRL_LBL = 652.589;

// Order/row/musplus timelines built from the two exact descrambled modules.
// The loader returns to MUSIC0 order 18 before U2E (MAIN/U2.ASM:880-887).
let music1Timeline = null, u2eMusic0Timeline = null;

// Phase-local clocks: music-time when each chain-loaded part actually started.
// null until that phase is entered. StepTo uses (mt - *T0), never absolute
// estimates, so a long/short techno no longer desyncs panic/mntscrl/lnszoom.
let panicT0 = null;
let mntscrlT0 = null;
let lnszoomT0 = null;
// Post-LNS&ZOOM chain-loaded parts (phase-local clocks)
let plzT0 = null, minvT0 = null, rayT0 = null, sinT0 = null, jpT0 = null;
let u2eT0 = null, endlogoT0 = null, credT0 = null, endscrlT0 = null;
let ddstarsT0 = 0;              // the hidden part's own origin (see HIDDEN below)
// Loader-gate sub-state (MAIN/U2.ASM between panic and mntscrl): 0=wait musplus<0, 1=wait musplus>0
let loaderGatePhase = 0;
// U2E restarts MUSIC0 at order 18. In a normal full run ENDLOGO does NOT
// restart at order 25; that fallback exists only when the U2E group is skipped.
const U2E_MUSIC_ORDER = 18;

function music1Elapsed(mt) { return mt - GLENZ_START; }

// MUSIC1's simulated length in seconds (last row start + that row's duration),
// set at boot. STMIK loops the playing module forever, so musplus queries past
// the timeline end must WRAP, not hold the final row: rowAtTime holds the last
// row (musplus −32) forever, which would make e.g. JPLOGO's `musplus<4` wait
// gate unpassable if the chain ever drifted past MUSIC1's final marker window
// — a permanent hang.
let music1DurationS = 0;
function music1LoopedElapsed(mt) {
  let e = music1Elapsed(mt);
  if (music1DurationS > 0 && e >= music1DurationS) e %= music1DurationS;
  return e;
}

// dis_musplus() at demo-time mt (MUSIC1). Lower-bound s3msim model.
function musplusAtDemoMt(mt) {
  if (!music1Timeline) return -32;
  return musplusAtTime(music1Timeline, music1LoopedElapsed(mt));
}

function musplusAtPartLocal(partT0, localS) {
  return musplusAtDemoMt(partT0 + localS);
}

function musicPositionAtPartLocal(partT0, localS) {
  if (!music1Timeline) return { musplus: -32, row: null, order: null };
  const elapsed = music1LoopedElapsed(partT0 + localS);
  const row = rowAtTime(music1Timeline, elapsed);
  return {
    musplus: musplusAtTime(music1Timeline, elapsed),
    row: row?.row ?? null,
    order: row?.orderIdx ?? null,
  };
}

// (Transport labels are the measured constants above — no boot-time refresh.)
// OUTTAA.C wfade[]: white-blend level per anim frame (63 = full white)
const WFADE = [63, 32, 16, 8, 4, 2, 1, 0, 0, 0,
               0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
               0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
               1, 2, 4, 6, 9, 14, 20, 28, 37, 46,
               56, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63];
const FBW = 704, FBH = 416;      // virtual canvas (planar 4*176 wide; tall enough for the 2x panorama)
const VIEW_W = 320, VIEW_H = 400;      // ALKU display window: 400 visible rows (fills the 4:3 raster)
const PICY = 50;                 // panorama top row in the canvas (rows 50..349 of the 400-row window)
const SCRLF = 9;                 // vframes per 1px scroll step (ALKU do_scroll)
const SCROLL_MAX = 320;          // scroll stops at the picture's right half = pixel-identical to U2ABG
const DEBUG = new URLSearchParams(location.search);
const SILENT = DEBUG.has('silent');
const CREDLOG = DEBUG.has('credlog');   // trace ALKU's credit loop
const PHASELOG = DEBUG.has('phaselog'); // trace phase transitions (see REGENERATE above)
let phaselogDone = false;
const JUMP = parseFloat(DEBUG.get('jump') || '0');
const PART_JUMP = DEBUG.get('part');    // named entry point; resolved in boot()

// ?part=hidden is the port's `SECOND U`: the loader's partsmask[8] is 80h — bit
// 7 alone — so that switch runs DDSTARS and no other part of the demo. This runs
// it the same way, outside the phase chain entirely, on MUSIC0 from order 70
// (MAIN/U2.ASM: restartmus ax=0, bx=70 immediately before `exehid`).
const HIDDEN = PART_JUMP === 'hidden' || PART_JUMP === 'u' || PART_JUMP === 'ddstars';
const HIDDEN_MUSIC_ORDER = 70;

// dis_sync() section start times (seconds into MUSIC0), computed with
// libopenmpt from the descrambled song. The intro plays MUSIC0.S3M
// ("UnreaL ][ - The 2ND Reality", the slow 2-min intro arrangement) from
// order 0 — U2.ASM starts module 0 for a full-demo run. Section N drives
// choreography step N via the DIS ordersync table (ord/row -> section).
//  1 FC Production  2 First/Assembly  3 in<Dolby>  4 gfx  5 music  6 code
//  7 additional     8 exit    9 (unused here)   10 PAM's entry gate
// Patched-module (120 BPM) times = original libopenmpt-derived values × 25/24
// (see the TIMEBASE note above U2A_START).
//
// STRICTLY-AFTER semantics. DIS/DISINT.ASM's
// sync_10 — the real INDEMO implementation — is:
//     dx = (np_ord<<8)|np_row;  bx = ordersync1;  cx = 16
//   @@2: cmp dx,cs:[bx] / jbe @@1 / add bx,4 / loop @@2
//   @@1: mov ax,cs:[bx-2]        ; the value of the PREVIOUS entry
// It scans to the first table key >= the current position and returns the
// preceding entry's section. So section N is returned only once the position is
// STRICTLY PAST key[N] — the first row that reports section N is one row after
// the threshold, not the threshold row itself. ordersync1's keys are
//   0x0000:0 0x0200:1 0x0300:2 0x032f:3 0x042f:4 0x052f:5 0x062f:6 0x072f:7
//   0x082f:8 0x0900:9 0x0d00:10  (then MUSIC1-era 0x3d00.. reuse)
// so e.g. section 1 starts at order 2 row 1, not order 2 row 0 — the threshold
// row's own time would fire one row (0.125 s at this module's 120 BPM / speed 6)
// early.
const SYNC_S = [0, 16.125, 24.125, 30.0, 38.0, 46.0, 54.0, 62.0, 70.0, 72.125, 104.125];

// FONA glyph order (exact CP437 bytes from ALKU/MAIN.C). 0x8f/0x99 are the
// "Dolby Surround" logo glyphs used by the third title card.
const FONAORDER = [
  ...range(0x41, 0x58), // A..X  (note: no Y,Z)
  ...range(0x61, 0x7a), // a..z
  ...range(0x30, 0x39), // 0..9
  0x21, 0x3f, 0x2c, 0x2e, 0x3a,       // ! ? , . :
  0x8f, 0x8f,                          // dolby glyph a,b
  0x28, 0x29, 0x2b, 0x2d, 0x2a, 0x3d, // ( ) + - * =
  0x27,                                // '
  0x8f, 0x99,                          // dolby glyph c,d
];
function range(a, b) { const o = []; for (let i = a; i <= b; i++) o.push(i); return o; }

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------
let fontStrip = null;   // Uint8Array(32*1500), values 0x40/0x80/0xc0 (0 bg)
let fonap = new Int32Array(256), fonaw = new Int32Array(256);
let hoiPix = null;      // Uint8Array(640*200) panorama, chunky indexed
let picPalRaw = null;   // Uint8Array(768) picture palette, 6-bit
let musicBytes = null;

const FONT_H = 32, FONT_STRIDE = 1500;

async function loadAssets() {
  const [fRes, hRes, mRes] = await Promise.all([
    fetch('assets/fona.bin'), fetch('assets/hzpic.bin'), fetch('assets/music0.s3m')]);

  // --- FONA: 30 rows x 1500 of 2-bit intensity -> 0x40/0x80/0xc0, padded to 32 rows
  const raw = new Uint8Array(await fRes.arrayBuffer());
  const rows = Math.floor(raw.length / FONT_STRIDE);         // 30
  fontStrip = new Uint8Array(FONT_H * FONT_STRIDE);
  const map = [0, 0x40, 0x80, 0xc0];
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < FONT_STRIDE; x++)
      fontStrip[y * FONT_STRIDE + x] = map[raw[y * FONT_STRIDE + x] & 3];
  segmentFont();

  // --- HOI: 'Uh' header(16) + palette(768,6-bit) + 640x200 chunky pixels
  const hz = new Uint8Array(await hRes.arrayBuffer());
  picPalRaw = hz.slice(16, 16 + 768);
  hoiPix = hz.slice(784, 784 + 640 * 200);

  // STARTMUS.C patches MUSIC0's initial tempo byte in memory before handing
  // the module to STMIK (module[50] = 0x78). Apply that release-loader patch
  // before both playback and timeline simulation.
  const music0Buffer = await mRes.arrayBuffer();
  new Uint8Array(music0Buffer)[50] = 0x78;
  musicBytes = descramble(music0Buffer);
}

// Port of ALKU init()'s glyph scan: walk the 1500-wide strip, a "blank"
// column is all-zero over the font height; each non-blank run is the next
// glyph in FONAORDER. Records start column (fonap) and width (fonaw).
function segmentFont() {
  const blank = x => {
    for (let y = 0; y < FONT_H; y++) if (fontStrip[y * FONT_STRIDE + x]) return false;
    return true;
  };
  let x = 0;
  for (const c of FONAORDER) {
    while (x < FONT_STRIDE && blank(x)) x++;
    const b = x;
    while (x < FONT_STRIDE && !blank(x)) x++;
    fonap[c] = b; fonaw[c] = x - b;
  }
  fonap[0x20] = FONT_STRIDE - 20; fonaw[0x20] = 16;   // space
}

// ---------------------------------------------------------------------------
// Palettes (port of ALKU init() lines 184-242)
// ---------------------------------------------------------------------------
let picPal, palette2, fade2, fade1;    // Uint8Array(768) 6-bit
let d_textin, d_textout, d_picin;      // Int32Array(768) per-frame fade deltas (8.8)

function setupPalettes() {
  picPal = new Uint8Array(768);        // picture palette, then extended (idx 64+ mirror 0-63)
  palette2 = new Uint8Array(768);      // picture + text tint
  fade2 = new Uint8Array(768);         // black bg + text tint colors
  fade1 = new Uint8Array(768);         // all black

  const src = picPalRaw;
  for (let a = 0; a < 256; a++) {
    const y = a * 3;
    if (a < 64) {
      palette2[y] = src[y]; palette2[y + 1] = src[y + 1]; palette2[y + 2] = src[y + 2];
      // fade2 stays 0 (black)
    } else {
      const ti = a < 128 ? 1 : a < 192 ? 2 : 3;   // text color index for this block
      const base = a & 63;                         // picture color 0-63
      for (let ch = 0; ch < 3; ch++) {
        const tc = src[ti * 3 + ch];
        fade2[y + ch] = tc;
        palette2[y + ch] = (tc * 63 + src[base * 3 + ch] * (63 - tc)) >> 6;
      }
    }
  }
  // picPal = picture palette with idx 64-255 mirroring 0-63 (text invisible)
  picPal.set(src);
  for (let b = 192; b < 768; b++) picPal[b] = picPal[b - 192];

  d_textin = new Int32Array(768);
  d_textout = new Int32Array(768);
  d_picin = new Int32Array(768);
  for (let i = 0; i < 768; i++) {
    d_textin[i]  = Math.trunc((palette2[i] - picPal[i]) * 256 / 64);
    d_textout[i] = Math.trunc((picPal[i] - palette2[i]) * 256 / 64);
    d_picin[i]   = Math.trunc((picPal[i] - fade1[i]) * 256 / 128);
  }
}

// ---------------------------------------------------------------------------
// Virtual VGA framebuffer + "copper"
// ---------------------------------------------------------------------------
const FB = new Uint8Array(FBW * FBH);
const dac = new Uint8Array(768);              // live 6-bit palette (what displays)
// Credits are drawn at a FIXED screen position and composited over the
// (scrolling) panorama each frame — in the original the text is XOR-drawn at
// an offset that tracks the scroll, so it stays put while the picture slides
// under it. This overlay holds the credit glyph values (0x40/0x80/0xc0) in
// screen space; present() ORs it into the windowed panorama.
const creditOverlay = new Uint8Array(VIEW_W * VIEW_H);

// copper state
let frameCount = 0;
let cop_start = 0, cop_scrl = 0;              // hardware scroll (word addr, pixel pan)
let cop_dofade = 0;                            // frames of incremental fade left
let cop_fadepal = null;                        // Int32Array(768) delta being applied
const accum16 = new Int32Array(768);           // fade accumulator (value<<8 | frac)

function putpixel(x, y, c) { if (x >= 0 && x < FBW && y >= 0 && y < FBH) FB[y * FBW + x] = c; }
function getpixel(x, y) { return (x >= 0 && x < FBW && y >= 0 && y < FBH) ? FB[y * FBW + x] : 0; }

// copper2: set whole palette immediately from a 768 6-bit array
function setDAC(pal) { dac.set(pal); }

// copper3: one frame of incremental fade (accum += delta; dac = accum>>8)
function copperFadeStep() {
  if (cop_dofade <= 0 || !cop_fadepal) return;
  cop_dofade--;
  for (let i = 0; i < 768; i++) {
    accum16[i] += cop_fadepal[i];
    let v = accum16[i] >> 8;
    dac[i] = v < 0 ? 0 : v > 63 ? 63 : v;
  }
}
// prime the accumulator from a base 6-bit palette (memcpy(fadepal,fade1,...))
function primeFade(base) { for (let i = 0; i < 768; i++) accum16[i] = base[i] << 8; }

// ---------------------------------------------------------------------------
// Font rendering (port of prt/prtc/addtext)
// ---------------------------------------------------------------------------
// draw text into FB by OR-ing glyph values (prt): text pixel |= glyph
function prt(x, y, str) {
  for (const ch of str) {
    const c = ch.charCodeAt(0);
    const w = fonaw[c] || 0, sx0 = fonap[c] || 0;
    for (let gx = 0; gx < w; gx++) {
      for (let gy = 0; gy < FONT_H; gy++) {
        const d = fontStrip[gy * FONT_STRIDE + sx0 + gx];
        if (d) putpixel(x + gx, y + gy, getpixel(x + gx, y + gy) | d);
      }
    }
    x += w + 2;
  }
}
function textWidth(str) { let w = 0; for (const ch of str) w += (fonaw[ch.charCodeAt(0)] || 0) + 2; return w; }
function prtc(x, y, str) { prt(x - (textWidth(str) >> 1), y, str); }
// draw a single glyph by raw code (for the Dolby logo chars)
function prtGlyphCode(x, y, code) {
  const w = fonaw[code] || 0, sx0 = fonap[code] || 0;
  for (let gx = 0; gx < w; gx++)
    for (let gy = 0; gy < FONT_H; gy++) {
      const d = fontStrip[gy * FONT_STRIDE + sx0 + gx];
      if (d) putpixel(x - (w >> 1) + gx, y + gy, getpixel(x - (w >> 1) + gx, y + gy) | d);
    }
}

// fonapois(): darken the text overlay bits (clear high 2 bits) over the text
// band, i.e. erase drawn text. Here: clear FB cells that hold text indices.
function clearText() {
  for (let y = 32; y < 300; y++)
    for (let x = 0; x < FBW; x++) FB[y * FBW + x] &= 0x3f;
}

// ---------------------------------------------------------------------------
// Music (chiptune3 / libopenmpt) — same approach as the glenz port
// ---------------------------------------------------------------------------
let musicCtx = null, musicStart = 0, musicReady = false, chip = null, silentStart = 0;
// Ignore worklet position reports until this AudioContext time — set after
// every module seek so in-flight pre-seek messages can't move the clock.
let suppressPosUntil = 0;

async function startMusic() {
  if (SILENT) { silentStart = performance.now() / 1000; musicReady = true; return; }
  const { ChiptuneJsPlayer } = await import('./vendor/chiptune3.js');
  // repeatCount -1: STMIK plays a module's S3M loop indefinitely — the demo
  // never stops the tracker engine itself (MAIN/U2.ASM only fademusic()s at
  // the very end). With 0, MUSIC0's hidden order-18 sequence hit its Bxx
  // loop point 363.4s after the U2E restart and went SILENT mid-ENDSCRL
  //; the original keeps looping under the scroller.
  chip = new ChiptuneJsPlayer({ repeatCount: -1 });
  await new Promise(res => { chip.onInitialized(res); });
  musicCtx = chip.context;
  chip.play(musicBytes);
  musicStart = musicCtx.currentTime;
  activeModuleOriginMt = 0;
  musicReady = true;
  chip.onProgress((d) => {
    const pos = (d && typeof d.pos === 'number') ? d.pos : null;
    if (pos === null || pos <= 0.5) return;
    // Module restarts later in the demo make the active module's position
    // independent of the continuous demo clock. activeModuleOriginMt is the
    // demo time corresponding to module position zero.
    // No correction:
    //  - while a jump cascade is settling (the clock was just set
    //    authoritatively by jumpTo and the module seek is still deferred);
    //  - after the U2E-era MUSIC0 restart: seeks into the hidden order-18
    //    sequence reset libopenmpt's position counter to 0 and the sequence
    //    Bxx-loops, so pos no longer maps affinely onto demo time. The clock
    //    free-runs on the AudioContext time base, which is what the drift
    //    correction was slaved to anyway.
    if (replayAll || pendingEraSeek !== null || u2eT0 !== null) return;
    if (musicCtx.currentTime < suppressPosUntil) return;
    const drift = (musicCtx.currentTime - musicStart) - (activeModuleOriginMt + pos);
    if (Math.abs(drift) > 0.08) musicStart += drift * 0.5;
  });
}
function musicTime() {
  if (!musicReady) return -1;
  if (SILENT) return performance.now() / 1000 - silentStart + JUMP;
  return musicCtx.currentTime - musicStart;
}
// A/V skew probe: mt is the VISUAL clock, (activeModuleOriginMt + chip's reported
// module position) is where the AUDIO actually is. skew > 0 means the visuals are
// running ahead of the music. Used by tools/av_skew.mjs.
window.__av = () => ({
  mt: musicTime(), pos: chip ? chip.getCurrentTime() : null,
  origin: activeModuleOriginMt, phase, mod: activeMod,
});
// dis_sync(): which music section are we in (0..10)
function disSync(mt) { let s = 0; for (let i = 1; i < SYNC_S.length; i++) if (mt >= SYNC_S[i]) s = i; return s; }

// ---------------------------------------------------------------------------
// Choreography — Phase A (centered title cards), Phase B stubbed
// ---------------------------------------------------------------------------
const TITLES = [
  { sync: 1, lines: [[160, 120, 'A'], [160, 160, 'Future Crew'], [160, 200, 'Production']] },
  { sync: 2, lines: [[160, 160, 'First Presented'], [160, 200, 'at Assembly 93']] },
  { sync: 3, lines: [[160, 120, 'in']], glyphs: [[160, 160, 0x8f], [160, 179, 0x99]] },
];

let phase = 'title';
let titleIdx = -1;
const FADE_F = 64;   // ALKU's dofade/cop_dofade step count

// Title cards: each is a fixed dofade(64)+wait(300)+dofade(64) = 428-vblank
// (6.1143s) sequence, gated to start no earlier than its own dis_sync()
// boundary (ALKU/MAIN.C:59-84, confirmed directly against source — dofade's
// `for(a=0;a<64;a++){...while(frame_count<1);frame_count=0;}` is a genuine
// 1-vblank-per-step fade, wait(300) a genuine 300-vblank hold). This is NOT
// three independent windows keyed to SYNC_S — `while(dis_sync()<N)` only
// waits *at least* until N, so if a card's own 428-vblank cycle overruns
// its nominal window, the next card starts LATE, off the music grid. Card 2
// needs 428/70=6.1143s but only has SYNC_S[3]-SYNC_S[2]=5.875s before card
// 3's nominal boundary, so card 3 genuinely starts ~0.24s late (29.875 ->
// ~30.11s in patched-module time) — this Math.max chain reproduces that
// exactly (rather than a per-card heuristic that
// assumed independent windows and got card 3's start wrong).
const CARD_FRAMES = 64 + 300 + 64;
const CARD_START = [0, 0, 0];
CARD_START[0] = SYNC_S[1];
CARD_START[1] = Math.max(SYNC_S[2], CARD_START[0] + CARD_FRAMES / VBLANK_HZ);
CARD_START[2] = Math.max(SYNC_S[3], CARD_START[1] + CARD_FRAMES / VBLANK_HZ);
const PHASEB_START = Math.max(SYNC_S[4], CARD_START[2] + CARD_FRAMES / VBLANK_HZ);

// Phase B: credit groups. Each line is [ty, text]; canvas row = ty + 100.
// (ALKU addtext/faddtext with tx=160 centered; sync 4+tptr gates each group.)
const CREDITS = [
  [[50, 'Graphics'], [90, 'Marvel'], [130, 'Pixel']],
  [[50, 'Music'], [90, 'Purple Motion'], [130, 'Skaven']],
  [[30, 'Code'], [70, 'Psi'], [110, 'Trug'], [148, 'Wildfire']],
  [[50, 'Additional Design'], [90, 'Abyss'], [130, 'Gore']],
  [],   // blank (sync 8 = exit)
];
// Credit-machine state. ALKU/MAIN.C's credit loop is a single `for(f=60;
// a<320;)` whose body runs ONCE PER SCROLL PIXEL, because it ends in
// do_scroll(1) and do_scroll blocks on `while(frame_count<SCRLF)` — so one
// iteration = SCRLF = 9 vblanks. `credF` is that loop's `f`; `credVb` counts
// vblanks since phase B opened so iterations land on the 9-vblank grid.
let scrollState = 'picfade';   // picfade -> run <-> syncwait -> postcredits
let scrollA = 1, tptr = 0;
let credVb = 0, credF = 60, credWait = 0;

// U2A (spaceship) state
const u2aFB = new Uint8Array(320 * 200);

function drawTitle(t) {
  clearText();
  for (const [x, y, s] of (t.lines || [])) prtc(x, y, s);
  for (const [x, y, code] of (t.glyphs || [])) prtGlyphCode(x, y, code);
}
// direct 64-frame crossfade fade1<->fade2 (ALKU dofade), step given progress a (0..64)
function dofadeStep(pal1, pal2, a) {
  for (let i = 0; i < 768; i++) dac[i] = (pal1[i] * (64 - a) + pal2[i] * a) >> 6;
}

let vframeDone = -1;
let curVbT = 0;      // music time of the vblank currently being simulated

// blit the HOI panorama, vertically DOUBLED — exactly as ALKU's outline()
// streams it (each source row -> two display rows). outline uses 150 source
// rows, so the picture spans canvas rows PICY..PICY+300; the visible window
// (rows PICY..PICY+200) shows the top ~100 source rows filling the screen.
function blitPanorama() {
  for (let y = 0; y < 150; y++) {
    const s = y * 640, d0 = (PICY + 2 * y) * FBW, d1 = (PICY + 2 * y + 1) * FBW;
    for (let x = 0; x < 640; x++) { const p = hoiPix[s + x]; FB[d0 + x] = p; FB[d1 + x] = p; }
  }
}
// OR a string's glyphs into the credit overlay at a fixed screen position,
// centered on screenX. Glyph values (0x40/0x80/0xc0) select the tinted palette.
function overlayText(screenX, screenY, str) {
  let x = screenX - (textWidth(str) >> 1);
  for (const ch of str) {
    const c = ch.charCodeAt(0), w = fonaw[c] || 0, sx0 = fonap[c] || 0;
    for (let gx = 0; gx < w; gx++)
      for (let gy = 0; gy < FONT_H; gy++) {
        const d = fontStrip[gy * FONT_STRIDE + sx0 + gx];
        if (!d) continue;
        const px = x + gx, py = screenY + gy;
        if (px >= 0 && px < VIEW_W && py >= 0 && py < VIEW_H) creditOverlay[py * VIEW_W + px] |= d;
      }
    x += w + 2;
  }
}
// render credit group idx at a FIXED screen position (does not scroll).
// screen row = canvas row ty+100 (window starts at canvas row 0).
function drawCredit(idx) {
  creditOverlay.fill(0);
  for (const [ty, s] of CREDITS[idx]) overlayText(VIEW_W >> 1, ty + 100, s);
}

function enterPhaseB() {
  FB.fill(0);                 // clear Phase A title text
  creditOverlay.fill(0);
  blitPanorama();
  primeFade(fade1);
  cop_fadepal = d_picin; cop_dofade = 128;
  cop_start = 0; cop_scrl = 0;
  scrollA = 1; tptr = 0; scrollState = 'picfade';
  credVb = 0; credF = 60; credWait = 0;
  phase = 'scroll';
}

function stepFrame(mt) {
  const sec = disSync(mt);
  if (phase === 'ddstars') return;      // no chain, no gates: it just runs
  if (phase === 'u2a') { stepU2A(mt); return; }
  if (phase === 'pam') { stepPam(mt); return; }
  if (phase === 'beg') { stepBeg(mt); return; }
  if (phase === 'glenz') { stepGlenz(mt); return; }
  if (phase === 'tunnel') { stepTunnel(mt); return; }
  if (phase === 'techno') { stepTechno(mt); return; }
  if (phase === 'panic') { stepPanic(mt); return; }
  if (phase === 'loadergate') { stepLoaderGate(mt); return; }
  if (phase === 'mntscrl') { stepMntscrl(mt); return; }
  if (phase === 'lnszoom') { stepLnszoom(mt); return; }
  if (phase === 'plzpart') { stepPlzpart(mt); return; }
  if (phase === 'minvball') { stepMinvball(mt); return; }
  if (phase === 'rayscrl') { stepRayscrl(mt); return; }
  if (phase === 'sinfield') { stepSinfield(mt); return; }
  if (phase === 'jplogo') { stepJplogo(mt); return; }
  if (phase === 'u2e') { stepU2e(mt); return; }
  if (phase === 'endlogo') { stepEndlogo(mt); return; }
  if (phase === 'cred') { stepCred(mt); return; }
  if (phase === 'endscrl') { stepEndscrl(mt); return; }
  // Phase B is the one phase whose state machine is a per-vblank ITERATION
  // (ALKU's credit loop), not a pure function of the clock: it waits on both a
  // music section and the scroll column's parity. tick() calls stepFrame `steps`
  // times with a single mt, so during a jump replay a constant mt would freeze
  // the column and the parity wait could never clear. curVbT is the music time
  // of the vblank actually being simulated, which advances across the replay.
  if (phase === 'scroll') { stepScroll(curVbT, disSync(curVbT)); return; }
  if (phase === 'end') return;
  if (phase !== 'title') return;

  // Phase A: section 0 is the black opening (the music swells over darkness,
  // ~15s — verified against the reference). Cards 1-3 then each run their
  // own fixed 428-vblank dofade+wait+dofade cycle, chained sequentially off
  // CARD_START/PHASEB_START above (NOT independent per-section windows).
  // Uses curVbT, not mt, so that enterPhaseB lands on the SAME vblank whether
  // this is live playback or a jump replay — phase B's credit loop keys its
  // 9-vblank iteration grid and its 128-vblank picture fade off that instant.
  const tt = curVbT;
  if (tt >= PHASEB_START) { enterPhaseB(); return; }
  if (tt < CARD_START[0]) { setDAC(fade1); return; }

  let idx = 0;
  if (tt >= CARD_START[2]) idx = 2; else if (tt >= CARD_START[1]) idx = 1;
  if (idx !== titleIdx) { clearText(); drawTitle(TITLES[idx]); titleIdx = idx; }

  const cardT = (tt - CARD_START[idx]) * VBLANK_HZ;   // vblanks into this card's own cycle
  let a;
  if (cardT < 64) a = cardT;                          // dofade(fade1,fade2)
  else if (cardT < 64 + 300) a = FADE_F;               // wait(300)
  else a = FADE_F - (cardT - (64 + 300));              // dofade(fade2,fade1)
  a = a < 0 ? 0 : a > FADE_F ? FADE_F : a;
  dofadeStep(fade1, fade2, a);
}

// Phase B: horizontal panorama scroll + credit fade cycle (gated by dis_sync)
//
// Rewritten to follow ALKU/MAIN.C's actual loop instead
// of an invented in/hold/out state machine. The original is:
//
//   for(f=60; a<320 && !dis_exit();) {
//     if(f==0)      { cop_fadepal=textin;  cop_dofade=64; f+=20; }
//     else if(f==50){ cop_fadepal=textout; cop_dofade=64; f++;   }
//     else if(f>50 && cop_dofade==0) {
//         cop_pal=palette; do_pal=1; f++;
//         memset(tbuf,0,186*320);
//         switch(tptr++) { ...draw this group... }
//         while(((a&1) || dis_sync()<4+tptr) && !dis_exit() && a<319) do_scroll(0);
//         aa=a; if(aa<320-12) fmaketext(aa+16);
//         f=0;
//     }
//     else f++;
//     do_scroll(1);
//   }
//   if(f>63/SCRLF) dofade(palette2,palette);
//
// Three things follow that the old model got wrong:
//  1. `switch(tptr++)` runs BEFORE the wait, so the wait after drawing group N
//     is for `dis_sync() >= 4+(N+1)` = 5+N. Group N therefore becomes visible
//     at section 5+N, and the old code's `sec >= 4+tptr` fired a whole section
//     (~8s) early on every group — the credits ran one section ahead all the
//     way through.
//  2. Group 0 is NOT special. f=60 just makes the first iteration fall into the
//     `f>50 && cop_dofade==0` branch, so group 0 takes the identical path:
//     draw, wait for section 5, then f=0 fades it IN. The old code snapped
//     straight to palette2 with no fade at all.
//  3. The hold is a fixed count of loop iterations, not "start fading out so it
//     lands on the next section boundary": f runs 20->50 = 30 iterations = 270
//     vblanks from the fade-in start, then a 64-vblank fade-out. The section
//     gate only paces the START of each group's cycle.
function stepScroll(mt, sec) {
  // scroll one pixel every SCRLF vblanks from the scroll section start, stopping
  // at SCROLL_MAX. Derived from the music clock so a timeline seek lands on the
  // exact column.
  //
  // SCROLL_MAX (the note above, investigated and deliberately left at 320): read
  // literally, MAIN.C rests one pixel earlier — the inner wait caps at `a<319`
  // and the outer loop's last do_scroll(1) displays a=319 before a becomes 320.
  // But the port's canvas is a static 640-wide blit scrolled by a window, while
  // the original streams fresh picture columns into a 704-pixel ring at word
  // column a/4+86, so the two `a` bases need not coincide. The decisive check is
  // the hand-off: panorama columns 320..639 are byte-identical to the shipped
  // U2A background (u2a_bg.bin, +192 palette indices) over the whole 25..174
  // content band — 100.00% at offset 320 and 82.63% at 319. Resting at 319 would
  // put a visible 1px jump on a transition the demo designed to be invisible,
  // so 320 is the value that reproduces the original's *output*.
  const sa = Math.floor((mt - SYNC_S[4]) * VBLANK_HZ / SCRLF);
  scrollA = sa < 1 ? 1 : sa > SCROLL_MAX ? SCROLL_MAX : sa;
  cop_start = scrollA >> 2; cop_scrl = (scrollA & 3) * 2;

  if (scrollState === 'postcredits') {
    // credits done; the scroll runs out and clamps at SCROLL_MAX, the screen
    // sits on the U2ABG-identical view, then the spaceship scene takes over
    // with NO fade — in the original the mode switch is invisible by design.
    if (mt >= U2A_START) enterU2A();
    return;
  }

  // One loop iteration per SCRLF vblanks (do_scroll's `while(frame_count<SCRLF)`).
  const boundary = (credVb % SCRLF) === 0;
  credVb++;
  if (!boundary) return;

  if (scrollState === 'picfade') {
    // `for(a=1,p=1,f=0,frame_count=0; cop_dofade!=0;) do_scroll(2);` — the
    // 128-step picture fade-in, scrolling all the while. Exits on the first
    // iteration boundary at which the fade has finished (vblank 135, a=16),
    // which is also where the credit loop's f=60 first iteration begins.
    if (cop_dofade !== 0) return;
    scrollState = 'run'; credF = 60; tptr = 0;
  }

  if (scrollState === 'syncwait') {
    // while(((a&1) || dis_sync()<4+tptr) && a<319) do_scroll(0);
    if (((scrollA & 1) || sec < credWait) && scrollA < 319) return;
    credF = 0;            // ...then f=0, and the NEXT iteration starts the fade-in
    scrollState = 'run';
    if (CREDLOG) console.log(`[cred] t=${mt.toFixed(3)} a=${scrollA} sync=${sec} -> group ${tptr - 1} fades in`);
    return;
  }

  // outer loop condition `a<320`: the scroll running out ends the credit machine
  // wherever it happens to be, and MAIN.C then crossfades the text tint away
  // (`if(f>63/SCRLF) dofade(palette2,palette)` — 63/9 = 7, so any f past the
  // fade-in does it). The panorama then holds until U2A's own gate.
  if (scrollA >= SCROLL_MAX) {
    if (credF > 7) { cop_fadepal = d_textout; cop_dofade = FADE_F; }
    scrollState = 'postcredits';
    return;
  }

  if (credF === 0) { cop_fadepal = d_textin; cop_dofade = FADE_F; credF = 20; }
  else if (credF === 50) { cop_fadepal = d_textout; cop_dofade = FADE_F; credF = 51; }
  else if (credF > 50 && cop_dofade === 0) {
    setDAC(picPal); primeFade(picPal);          // cop_pal=palette; do_pal=1
    credF++;
    const g = tptr++;                            // switch(tptr++)
    if (g < CREDITS.length) drawCredit(g);
    else {                                       // MAIN.C's `default:` arm
      creditOverlay.fill(0);
      overlayText(VIEW_W >> 1, 80 + 100, 'BUG BUG BUG');
      overlayText(VIEW_W >> 1, 130 + 100, 'Timing error');
      console.warn('[ALKU] credit timing overrun — reached MAIN.C\'s BUG BUG BUG arm');
    }
    credWait = 4 + tptr;                         // = 5 + g
    scrollState = 'syncwait';
    if (CREDLOG) console.log(`[cred] t=${mt.toFixed(3)} a=${scrollA} drew group ${g} -> wait sync>=${credWait}`);
  } else credF++;
}
function onPartEnd() {
  const ec = document.getElementById('endcard');
  if (ec) ec.style.display = 'flex';
}

// ---------------------------------------------------------------------------
// Transport — play/pause, prev/next part, current section display
// ---------------------------------------------------------------------------
// Transport seek labels — post-TECHNO times are the measured-cascade
// constants defined up top; live playback uses phase-local clocks.
function partsList() {
  // Transport labels — times after LNS&ZOOM are rough estimates for seeking only.
  // Live cascade uses phase-local clocks + Ended() gates.
  return [
    ['TITLE CARDS', 0.0],
    ['PANORAMA + CREDITS', SYNC_S[4]],
    ['SHIP FLYBY', U2A_START],
    ['MOON EXPLOSION', PAM_START],
    ['SECOND REALITY', BEG_START],
    ['GLENZ VECTORS', GLENZ_START],
    ['DOT TUNNEL', TUNNEL_START],
    ['TECHNO', TECHNO_START],
    ['PANICEND', PANIC_START],
    ['MNTSCRL', MNTSCRL_START],
    // Measured silent cascade (see the constant block up top).
    // Live cascade uses Ended() gates — these labels are transport-only.
    ['LNS&ZOOM', LNSZOOM_START],
    ['PLZPART', PLZPART_LBL],
    ['MINVBALL', MINVBALL_LBL],
    ['RAYSCRL', RAYSCRL_LBL],
    ['3DSINFLD', SINFIELD_LBL],
    ['JPLOGO', JPLOGO_LBL],
    ['U2E VECTORS', U2E_LBL],
    ['ENDLOGO', ENDLOGO_LBL],
    ['CREDITS', CRED_LBL],
    ['ENDSCRL', ENDSCRL_LBL],
  ];
}
function partIndex(mt) {
  const PARTS = partsList();
  let i = 0;
  for (let k = 1; k < PARTS.length; k++) if (mt >= PARTS[k][1]) i = k;
  return i;
}
// Named entry points, one per partsList() slot, so a part can be linked to by
// name instead of by a second count that moves whenever a constant is re-derived.
// The original had the same idea in coarser form: SECOND.EXE took a digit 1-5 to
// start from one of five points (README.1ST), and the board's parts index is the
// same list at full resolution. parts.html at the repository root holds the
// matching table.
const PART_SLUG = [
  'cards', 'panorama', 'ship', 'moon', 'logo', 'glenz', 'tunnel', 'techno',
  'panic', 'mntscrl', 'lens', 'plasma', 'minvball', 'rayscrl', 'sinfield',
  'jellypic', 'u2e', 'endlogo', 'credits', 'endscrl',
];
// phase name -> partsList() index, for the readout. The phase is authoritative;
// the seek estimates in partsList() can lag the real chain by a part or two.
const PHASE_INDEX = {};
['title', 'scroll', 'u2a', 'pam', 'beg', 'glenz', 'tunnel', 'techno', 'panic',
 'mntscrl', 'lnszoom', 'plzpart', 'minvball', 'rayscrl', 'sinfield', 'jplogo',
 'u2e', 'endlogo', 'cred', 'endscrl'].forEach((p, i) => { PHASE_INDEX[p] = i; });
PHASE_INDEX.loadergate = PHASE_INDEX.panic;
PHASE_INDEX.end = PHASE_INDEX.endscrl;
function slugTime(slug) {
  const i = PART_SLUG.indexOf(String(slug || '').toLowerCase());
  return i < 0 ? null : partsList()[i][1];
}
let replayAll = false, paused = false, pausedAt = 0;
// Demo-time target of a jump whose audio-module seek is deferred until the
// replay cascade settles (era-aware seek; see jumpTo/applyEraSeek).
let pendingEraSeek = null;
function jumpTo(t) {
  if (!musicReady) return;
  // reset the whole state machine to boot state; the next tick replays the
  // timeline deterministically up to t (all transitions are music-time-based)
  phase = 'title'; titleIdx = -1;
  FB.fill(0); creditOverlay.fill(0);
  setDAC(fade1);
  cop_dofade = 0; cop_fadepal = null;
  cop_start = 0; cop_scrl = 0;
  scrollA = 1; tptr = 0; scrollState = 'picfade';
  credVb = 0; credF = 60; credWait = 0;
  u2aReset(); u2aEnded = false; u2aFrame = 0;
  pamF = 0; begC = 0;
  glenzReset(); tunnelReset(); technoReset(); panicReset(); mntscrlReset(); lnszoomReset();
  plzpartReset(); minvballReset(); rayscrlReset(); sinfieldReset(); jplogoReset();
  u2eReset(); endlogoReset(); credReset(); endscrlReset();
  panicT0 = mntscrlT0 = lnszoomT0 = null; loaderGatePhase = 0;
  plzT0 = minvT0 = rayT0 = sinT0 = jpT0 = u2eT0 = endlogoT0 = credT0 = endscrlT0 = null;
  vframeDone = -1; replayAll = true;
  const ec = document.getElementById('endcard');
  if (ec) ec.style.display = 'none';
  if (SILENT) {
    silentStart = performance.now() / 1000 - (t - JUMP);
    activeMod = t >= GLENZ_START ? 1 : 0;
  } else {
    // Set the demo clock immediately; DEFER the module-content seek until the
    // replay cascade settles (see tick()) — only then is it known which music
    // era the target lands in (MUSIC0 intro / MUSIC1 / MUSIC0-order-18 after
    // the U2E restart). Seeking MUSIC1 here for a post-JPLOGO target fed the
    // drift corrector a wrong-module position and collapsed the clock to a
    // frozen ENDSCRL within half a second.
    pendingEraSeek = t;
    musicStart = musicCtx.currentTime - t;
  }
}
// After a jump cascade settles, put the audio on the correct module+position
// for the era the target landed in. pos-after-seek semantics (verified against
// the shipped wasm): setOrderRow into the hidden sequence resets
// position_seconds to 0, so activeModuleOriginMt must be the demo time AT the
// seek — not u2eT0 — though with the drift corrector disabled post-restart it
// is bookkeeping only.
function applyEraSeek(mt) {
  if (SILENT || !chip) return;
  if (u2eT0 != null && mt >= u2eT0) {
    switchModule(0, 0, mt);
    const row = rowAtTime(u2eMusic0Timeline, mt - u2eT0);
    chip.setOrderRow(row?.orderIdx ?? U2E_MUSIC_ORDER, row?.row ?? 0);
    activeModuleOriginMt = mt;
  } else if (mt >= GLENZ_START) {
    switchModule(1, mt - GLENZ_START, mt);
  } else {
    switchModule(0, mt, mt);
  }
}
function togglePause() {
  if (!musicReady) return;
  paused = !paused;
  if (SILENT) {
    if (paused) pausedAt = performance.now() / 1000;
    else silentStart += performance.now() / 1000 - pausedAt;
  } else {
    if (paused) musicCtx.suspend();      // freezes ctx.currentTime = freezes mt
    else musicCtx.resume();
  }
  const pb = document.getElementById('ppBtn');
  if (pb) pb.textContent = paused ? '▶' : 'II';
}

// Leaving has to take the music with it, and nothing used to make it. An
// AudioWorklet goes on rendering after the page it belongs to has been navigated
// away from, because a standalone home-screen app does not destroy the document
// the way a browser tab does — it freezes it, or files it in the back/forward
// cache, and the audio thread never got the message. On an iPhone that is very
// audible: you leave the demo and the music follows you around the app.
//
// suspend(), not close(): a frozen page can be restored, and a closed
// AudioContext cannot be reopened, so closing it would mean coming back to a
// demo that is silent for good. Suspending also freezes ctx.currentTime, which
// is the demo's clock — so this is exactly a pause, and it resumes in step.
let pausedByHide = false;
function pauseForHide() {
  if (!musicReady || paused) return;
  pausedByHide = true;
  togglePause();
}
function resumeAfterHide() {
  if (!pausedByHide) return;
  pausedByHide = false;
  if (paused) togglePause();          // only ever undoes our own pause
}
addEventListener('pagehide', pauseForHide);
addEventListener('pageshow', (e) => { if (e.persisted) resumeAfterHide(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') pauseForHide();
  else resumeAfterHide();
});
// prev: restart current part, or go to the previous one if near its start
function prevPart() {
  if (HIDDEN) return;                    // there is nothing else running to seek to
  const PARTS = partsList();
  const mt = musicTime(), i = partIndex(mt);
  jumpTo((mt - PARTS[i][1] < 2 && i > 0) ? PARTS[i - 1][1] : PARTS[i][1]);
}
function nextPart() {
  if (HIDDEN) return;
  const PARTS = partsList();
  const i = partIndex(musicTime());
  if (i + 1 < PARTS.length) jumpTo(PARTS[i + 1][1]);
}
let shownPart = -1;
let shownPhase = '';
const PHASE_LABEL = {
  title: 'TITLE CARDS', scroll: 'PANORAMA + CREDITS', u2a: 'SHIP FLYBY',
  pam: 'MOON EXPLOSION', beg: 'SECOND REALITY', glenz: 'GLENZ VECTORS',
  tunnel: 'DOT TUNNEL', techno: 'TECHNO', panic: 'PANICEND',
  loadergate: 'PANICEND', mntscrl: 'MNTSCRL', lnszoom: 'LNS&ZOOM',
  plzpart: 'PLZPART', minvball: 'MINVBALL', rayscrl: 'RAYSCRL',
  sinfield: '3DSINFLD', jplogo: 'JPLOGO', u2e: 'U2E VECTORS',
  endlogo: 'ENDLOGO', cred: 'CREDITS', endscrl: 'ENDSCRL', end: 'ENDSCRL',
  ddstars: 'DDSTARS — HIDDEN PART',
};
// The board runs the demo inside one of its own screens, and shows what is
// playing in its top bar. It cannot read across the frame, so tell it: on every
// part change, and once a second so the clock ticks.
let sentLabel = '', sentSec = -1;
function reportToHost(label, i, mt, count = PART_SLUG.length, slug = PART_SLUG[i] || '') {
  if (window.top === window) return;
  const sec = mt | 0;
  if (label === sentLabel && sec === sentSec) return;
  sentLabel = label; sentSec = sec;
  try {
    window.parent.postMessage({
      sr: 'part', label, index: i, count, slug, t: mt, paused,
    }, location.origin);
  } catch { /* the board is not listening; the demo does not care */ }
}
function updateTransport() {
  const mt = musicTime();
  if (mt < 0) return;
  // The hidden part is not on the demo's timeline, so it has no part number and
  // no seek estimate — it reports itself, and its own frame counter is the clock.
  if (HIDDEN) {
    const label = PHASE_LABEL.ddstars;
    if (label !== shownPhase) {
      shownPhase = label;
      const el = document.getElementById('pname');
      if (el) el.textContent = label;
    }
    reportToHost(label, 0, Math.max(0, mt - ddstarsT0), 1, 'hidden');
    return;
  }
  const PARTS = partsList();
  const i = partIndex(mt);
  // The later chain is driven by executable exit gates rather than the rough
  // seek estimates in partsList(). Show the actual state-machine phase so the
  // UI cannot lag one or two parts behind the raster during live/replay runs.
  const label = PHASE_LABEL[phase] || PARTS[i][0];
  if (i !== shownPart || phase !== shownPhase) {
    shownPart = i; shownPhase = phase;
    const el = document.getElementById('pname');
    if (el) el.textContent = label;
  }
  reportToHost(label, PHASE_INDEX[phase] ?? i, mt);
}
// Q / Esc go back to the board, J to its parts index — which is the screen you
// came from if you picked this part by name, and the one you want in order to pick
// another. The board's own [J] row cannot help here: the demo has the keyboard
// while it is running, so the key has to be handled on this side.
//
// When the demo is embedded in the board's own screen it has to replace the whole
// page rather than just its frame.
const framed = window.top !== window;
function leaveToBoard(page = 'index.html') {
  if (framed) window.top.location.href = new URL(page, window.top.location.href).href;
  else location.href = '../' + (page === 'index.html' ? '' : page);
}
// embedded in the board's own screen, the back-to-board button is redundant
if (framed) {
  const b = document.getElementById('bbsBtn');
  if (b) b.style.display = 'none';
}

function initTransport() {
  const box = document.getElementById('parts');
  if (!box) return;
  const mk = (id, txt, title, fn) => {
    const b = document.createElement('div');
    b.className = 'pbtn'; b.id = id; b.textContent = txt; b.title = title;
    b.addEventListener('click', fn);
    box.appendChild(b);
    return b;
  };
  mk('prevBtn', '◀◀', 'Previous part (←)', prevPart);
  mk('ppBtn', 'II', 'Play / pause (space)', togglePause);
  mk('nextBtn', '▶▶', 'Next part (→)', nextPart);
  const name = document.createElement('div');
  name.className = 'pname'; name.id = 'pname'; name.textContent = '';
  box.appendChild(name);
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey) return;
    if (e.key === ' ') { e.preventDefault(); togglePause(); }
    else if (e.key === 'ArrowLeft') prevPart();
    else if (e.key === 'ArrowRight') nextPart();
    else if (e.key === 'q' || e.key === 'Q' || e.key === 'Escape') { leaveToBoard(); }
    else if (e.key === 'j' || e.key === 'J') { leaveToBoard('parts.html'); }
    else if (!HIDDEN) {
      const PARTS = partsList();
      const n = e.key.charCodeAt(0) - 49;   // '1'..'9' -> 0..8
      if (n >= 0 && n < PARTS.length) jumpTo(PARTS[n][1]);
    }
  });
}

// --- U2A phase: the spaceship flyby (3D scene, its own palette + framebuffer) ---
// One anim frame per vblank (70/s), exactly as the original paces it. When the
// stream ends (521 frames), the final background frame holds until U2A_END.
let u2aEnded = false, u2aFrame = 0;
const U2A_AF = DEBUG.has('af') ? parseInt(DEBUG.get('af')) : -1;   // debug: cap anim at frame N
function enterU2A() {
  u2aReset();
  u2aEnded = false; u2aFrame = 0;
  u2aRender(u2aFB);
  phase = 'u2a';
}
function stepU2A(mt) {
  if (mt >= PAM_START && U2A_AF < 0) { phase = 'pam'; return; }
  // U2A.C's render loop also carries its own music-position abort, checked at
  // the top of every iteration: `if(a>11 && b>54) break;` (order>11 && row>54,
  // the same int-0fch bx=6 query as the entry gate). First satisfied at order
  // 12 row 55 = 102.875s, which is AFTER the 521-frame animation stream ends at
  // 93.875+521/70 = 101.318s — so in a correct run the stream end always wins
  // and this never fires. Modelled anyway as the backstop it is: if the clock
  // ever ran long, the original would stop stepping here rather than keep
  // parsing. (Never reached before PAM_START = 104.125 either way.)
  if (mt >= U2A_ABORT_S && U2A_AF < 0 && !u2aEnded) { u2aEnded = true; u2aAllOff(); }
  // one anim frame per vblank since U2A_START, derived from the music clock so
  // a timeline seek lands on the exact frame; the stream end (521) holds.
  let target = Math.floor((mt - U2A_START) * VBLANK_HZ);
  if (U2A_AF >= 0 && target > U2A_AF) target = U2A_AF;   // debug cap
  while (!u2aEnded && u2aFrame < target) {
    if (u2aStep() === null) { u2aEnded = true; u2aAllOff(); }
    else u2aFrame++;
  }
}
// --- PAM phase: moon explosion FLI + white fades (port of PAM/OUTTAA.C) ---
// anim frame f = one per 4 vblanks from part start; frames 1..40 play the FLI,
// then the screen holds at white until BEG takes over.
let pamF = 0;
function stepPam(mt) {
  if (mt >= BEG_START) { phase = 'beg'; return; }
  pamF = Math.floor((mt - PAM_START) * VBLANK_HZ / 4);
  if (pamF < 0) pamF = 0;
}
// --- BEG phase: SECOND REALITY title fades in from white (port of BEG/BEG.C) ---
let begC = 0;   // fade progress 0..128 (white -> picture palette)
function stepBeg(mt) {
  begC = Math.max(0, Math.min(128, Math.floor((mt - BEG_FADE_START) * VBLANK_HZ)));
  if (mt >= GLENZ_START) { enterGlenz(); }
}
// --- GLENZ phase: the glenz vectors part, running on MUSIC1 ---
let activeMod = 0;   // which music module the player is on (0 or 1)
let activeModuleOriginMt = 0;
// put the player on module `mod` at `tInMod` seconds into that module, keeping
// the demo-time clock (mt) continuous: mt = module-1 time + GLENZ_START.
function switchModule(mod, tInMod, demoMt = musicTime()) {
  if (!SILENT) {
    if (activeMod !== mod) {
      chip.play(mod === 1 ? music1Bytes : musicBytes);   // starts at 0
      if (tInMod > 0.05) chip.setPos(tInMod);
    } else {
      chip.setPos(tInMod);
    }
    musicStart = musicCtx.currentTime - demoMt;
    // Progress messages already queued from the pre-seek module content would
    // otherwise be consumed AFTER the jump guards clear and ratchet the clock
    // toward the stale position (reproduced on a
    // jump-to-title from TECHNO). Blind the drift corrector briefly; it only
    // exists to trim slow drift, so a 300ms window costs nothing.
    suppressPosUntil = musicCtx.currentTime + 0.3;
  }
  activeMod = mod;
  activeModuleOriginMt = demoMt - tInMod;
}
function enterGlenz() {
  glenzReset();
  // Live natural transition only. During a jump replay, switching here would
  // clobber musicStart back to GLENZ_START mid-cascade and freeze the demo
  // until real time caught up — the
  // deferred applyEraSeek at cascade settle owns the audio for jumps.
  if (activeMod !== 1 && !replayAll) switchModule(1, 0, GLENZ_START);
  phase = 'glenz';
}
function stepGlenz(mt) {
  if (mt >= TUNNEL_START) { tunnelReset(); phase = 'tunnel'; }
}
// --- TUNNEL phase: the dot tunnel, same song (MUSIC1 keeps playing) ---
function stepTunnel(mt) {
  if (mt >= TECHNO_START) { technoReset(); phase = 'techno'; }
}
// --- TECHNO phase ---
function stepTechno(mt) {
  if (technoEnded() && phase !== 'panic') {
    // Shipped PANICEND.EXE is SHUTDOWN.C's _LOADER_ build (no monster.u in
    // PACKFINA.INC): the CRT-shutdown gag crushes whatever the loader left on
    // screen — TECHNO's parting troll endcard + DAC (confirmed by the capture's
    // crush-band colors).
    panicReset(technoVram400, technoPal);
    // Phase-local clock: panic starts when techno actually ended, not the label estimate.
    const endFr = technoEndFrames();
    panicT0 = (endFr !== Infinity && endFr > 0)
      ? TECHNO_START + endFr / VBLANK_HZ
      : mt;
    phase = 'panic';
  }
}
// --- PANIC phase ---
function stepPanic(mt) {
  if (panicEnded() && phase !== 'loadergate' && phase !== 'mntscrl') {
    // MAIN/U2.ASM: wait musplus<0 then musplus>0 before MNTSCRL
    loaderGatePhase = 0;
    phase = 'loadergate';
  }
}
// --- Loader gate (U2.ASM between PANICEND and MNTSCRL) — no EXE, music only ---
function stepLoaderGate(mt) {
  const m = musplusAtDemoMt(mt);
  if (loaderGatePhase === 0) {
    if (m < 0) loaderGatePhase = 1;
    // If already past the whole gate (jump catch-up), resolve via s3msim.
    if (music1Timeline && panicT0 != null) {
      const panicEnd = panicT0 + panicEndFrames() / VBLANK_HZ;
      const gateEnd = GLENZ_START + loaderGateEndTime(music1Timeline, music1Elapsed(panicEnd));
      if (mt >= gateEnd) {
        mntscrlReset();
        mntscrlT0 = gateEnd;
        phase = 'mntscrl';
      }
    }
  } else if (m > 0) {
    mntscrlReset();
    mntscrlT0 = mt;
    phase = 'mntscrl';
  }
}
// --- MNTSCRL phase ---
function stepMntscrl(mt) {
  if (mntscrlEnded() && phase !== 'lnszoom') {
    lnszoomReset();
    lnszoomT0 = (mntscrlT0 != null)
      ? mntscrlT0 + mntscrlDurationS()
      : mt;
    phase = 'lnszoom';
  }
}
// Chain-load T0 = previous T0 + measured duration so JUMP/replay catch-up
// lands mid-part with the correct local clock (same pattern as lnszoomT0).
function chainT0(prevT0, durationS, mt) {
  if (prevT0 != null && durationS != null && durationS > 0)
    return prevT0 + durationS;
  return mt;
}

// --- LNSZOOM phase ---
function stepLnszoom(mt) {
  if (lnszoomEnded() && phase !== 'plzpart') {
    plzpartReset();
    plzT0 = chainT0(lnszoomT0, lnszoomDurationS(), mt);
    phase = 'plzpart';
  }
}
// Remaining parts: PLZ → MINV → RAY → 3DSIN → JP → MUSIC0 order 18 →
// U2E → END → CRED → ENDSCRL. Order 25 is only the U2E-skipped loader path.
function stepPlzpart(mt) {
  if (plzpartEnded() && phase !== 'minvball') {
    minvballReset();
    minvT0 = chainT0(plzT0, plzpartDurationS(), mt);
    phase = 'minvball';
  }
}
function stepMinvball(mt) {
  if (minvballEnded() && phase !== 'rayscrl') {
    rayscrlReset();
    rayT0 = chainT0(minvT0, minvballDurationS(), mt);
    phase = 'rayscrl';
  }
}
function stepRayscrl(mt) {
  if (rayscrlEnded() && phase !== 'sinfield') {
    sinfieldReset();
    sinT0 = chainT0(rayT0, rayscrlDurationS(), mt);
    phase = 'sinfield';
  }
}
function stepSinfield(mt) {
  if (sinfieldEnded() && phase !== 'jplogo') {
    jplogoReset();
    jpT0 = chainT0(sinT0, sinfieldDurationS(), mt);
    phase = 'jplogo';
  }
}
function stepJplogo(mt) {
  if (jplogoEnded() && phase !== 'u2e') {
    u2eReset(jplogoVram, jplogoPal);
    u2eT0 = chainT0(jpT0, jplogoDurationS(), mt);
    // MAIN/U2.ASM passes AX=0, BX=18 to restartmus: MUSIC0, order 18.
    // MUSIC0's U2E sequence is after the module's normal end marker, so it
    // must be entered with an order/row seek just like restartmus(0,18).
    // During a jump replay the audio seek is deferred to applyEraSeek (at
    // cascade settle) — seeking here mid-replay would race the drift
    // corrector. Live transition only:
    if (!SILENT && chip && !replayAll) {
      const now = musicTime();
      const elapsed = Math.max(0, now - u2eT0);
      switchModule(0, 0, now);
      const row = rowAtTime(u2eMusic0Timeline, elapsed);
      chip.setOrderRow(row?.orderIdx ?? U2E_MUSIC_ORDER, row?.row ?? 0);
      // position_seconds restarts at 0 after the hidden-order seek, so the
      // origin is the seek moment (== u2eT0 up to one tick of lag).
      activeModuleOriginMt = now;
    }
    phase = 'u2e';
  }
}
function stepU2e(mt) {
  if (u2eEnded() && phase !== 'endlogo') {
    // Normal whattorun=7fh path falls straight through to ENDLOGO. The
    // order-25 restart at U2.ASM:900-905 is only the U2E-skipped fallback.
    endlogoReset(u2ePal);
    endlogoT0 = chainT0(u2eT0, u2eDurationS(), mt);
    phase = 'endlogo';
  }
}
function stepEndlogo(mt) {
  if (endlogoEnded() && phase !== 'cred') {
    credReset();
    credT0 = chainT0(endlogoT0, endlogoDurationS(), mt);
    phase = 'cred';
  }
}
function stepCred(mt) {
  if (credEnded() && phase !== 'endscrl') {
    endscrlReset();
    endscrlT0 = chainT0(credT0, credDurationS(), mt);
    phase = 'endscrl';
  }
}
function stepEndscrl(mt) {
  if (endscrlEnded() && phase !== 'end') {
    phase = 'end'; onPartEnd();
  }
}

function orderAtU2eLocal(localS) {
  if (!u2eMusic0Timeline) return 0;
  const r = rowAtTime(u2eMusic0Timeline, localS);
  return r ? r.orderIdx : 0;
}

function musplusAtU2eLocal(localS) {
  return u2eMusic0Timeline ? musplusAtTime(u2eMusic0Timeline, localS) : -32;
}

// ---------------------------------------------------------------------------
// Tick — advance virtual vblanks up to the music clock
// ---------------------------------------------------------------------------
function tick() {
  const mt = musicTime();
  if (mt < 0) return;
  const target = Math.floor(mt * VBLANK_HZ);
  let steps = target - vframeDone;
  if (steps <= 0) {
    // Frozen clock (paused) after a jump: the replay cascade already settled
    // in the first tick (the force loop walks the whole chain), but the
    // settle branch below is unreachable with no steps to run — resolve the
    // deferred era seek here so unpausing resumes with the right module.
    if (replayAll) {
      replayAll = false;
      if (pendingEraSeek !== null) { applyEraSeek(mt); pendingEraSeek = null; }
    }
    return;
  }
  // cap catch-up during live playback, but replay everything after a jump.
  // replayAll stays set across ticks (not one-shot) until the phase cascade
  // settles: techno/panic/mntscrl each only advance their own frame counter
  // via their own StepTo below, called once per tick, so a jump landing past
  // several of them needs one tick per transition to walk the chain. Without
  // this, only the first-reached phase gets a forced full catch-up and every
  // later one falls back to the 35/tick live cap -- visibly "fast-forwarding"
  // through whatever phase is mid-catch-up for a second or more.
  const replay = replayAll;
  if (steps > 35 && !JUMP && !replay) { vframeDone = target - 35; steps = 35; }
  const phaseBefore = phase;
  // ?phaselog traces every phase transition with the music time it fired at —
  // this is how the transport-label constants above are re-measured (they are
  // labels only; the live cascade uses the phase-local T0 chain).
  let phaseTrace = PHASELOG ? phase : null;
  for (let s = 0; s < steps; s++) {
    vframeDone++;
    frameCount++;
    curVbT = vframeDone / VBLANK_HZ;   // music time of THIS vblank (see stepFrame)
    copperFadeStep();
    stepFrame(mt);
    if (phaseTrace !== null && phase !== phaseTrace) {
      console.log(`[phase] ${phaseTrace} -> ${phase} at mt=${curVbT.toFixed(3)}`);
      phaseTrace = phase;
    }
  }
  if (phase === 'u2a') u2aRender(u2aFB);
  // glenz/tunnel do their own vblank catch-up; force a full replay after any
  // seek (transport jump or ?jump= debug boot) so state matches the clock
  const force = replay || !!JUMP;
  // The hidden part's clock starts where it was entered, not at the demo's
  // origin, because it is not on the demo's timeline at all. Everything below is
  // gated on a phase this one never takes, and every T0 stays null, so it falls
  // through to present() without touching the chain.
  if (phase === 'ddstars') ddstarsStepTo(mt - ddstarsT0, force);
  if (phase === 'glenz') glenzStepTo(mt - GLENZ_START, force);
  if (phase === 'tunnel' || (phase === 'end' && mt >= TUNNEL_START && mt < TECHNO_START)) {
    tunnelStepTo(mt - TUNNEL_START, force);
  }

  // Post-TECHNO modules: phase-local clocks + musplus callbacks (s3msim / live).
  const technoMus = (localS) => musplusAtPartLocal(TECHNO_START, localS);
  if (phase === 'techno' || phase === 'panic' || phase === 'loadergate' ||
      phase === 'mntscrl' || (phase === 'end' && mt >= TECHNO_START)) {
    technoStepTo(mt - TECHNO_START, force, chip ? chip.row : null, technoMus);
  }
  if (panicT0 != null && (phase === 'panic' || phase === 'loadergate' ||
      phase === 'mntscrl' || (phase === 'end' && mt >= panicT0))) {
    panicStepTo(mt - panicT0, force);
  }
  if (mntscrlT0 != null && (phase === 'mntscrl' || phase === 'lnszoom' ||
      (phase === 'end' && mt >= mntscrlT0))) {
    mntscrlStepTo(mt - mntscrlT0, force, (localS) => musplusAtPartLocal(mntscrlT0, localS));
  }
  if (lnszoomT0 != null && (phase === 'lnszoom' || phase === 'plzpart' || (phase === 'end' && mt >= lnszoomT0))) {
    lnszoomStepTo(mt - lnszoomT0, force, (localS) => musplusAtPartLocal(lnszoomT0, localS));
  }
  const musFrom = (t0) => (localS) => musplusAtPartLocal(t0, localS);
  // Under JUMP/replay, walk the chain-load cascade to completion in one tick:
  // each StepTo force-runs to (mt-T0); if that ends the part, stepFrame transitions
  // and we StepTo the next — without this, T0=mt left every new part at local 0
  // and post-LNS&ZOOM stayed black until wall-clock slowly advanced.
  const runPostLnsModules = () => {
    if (plzT0 != null && (phase === 'plzpart' || phase === 'minvball'))
      plzpartStepTo(mt - plzT0, force, musFrom(plzT0));
    if (minvT0 != null && (phase === 'minvball' || phase === 'rayscrl'))
      minvballStepTo(mt - minvT0, force, musFrom(minvT0));
    if (rayT0 != null && (phase === 'rayscrl' || phase === 'sinfield'))
      rayscrlStepTo(mt - rayT0, force,
        (localS) => musicPositionAtPartLocal(rayT0, localS));
    if (sinT0 != null && (phase === 'sinfield' || phase === 'jplogo'))
      sinfieldStepTo(mt - sinT0, force, musFrom(sinT0));
    if (jpT0 != null && (phase === 'jplogo' || phase === 'u2e'))
      jplogoStepTo(mt - jpT0, force, musFrom(jpT0));
    if (u2eT0 != null && (phase === 'u2e' || phase === 'endlogo')) {
      u2eStepTo(mt - u2eT0, force, musplusAtU2eLocal, orderAtU2eLocal);
    }
    if (endlogoT0 != null && (phase === 'endlogo' || phase === 'cred'))
      endlogoStepTo(mt - endlogoT0, force,
        (localS) => musplusAtU2eLocal((endlogoT0 - u2eT0) + localS));
    if (credT0 != null && (phase === 'cred' || phase === 'endscrl'))
      credStepTo(mt - credT0, force);
    if (endscrlT0 != null && (phase === 'endscrl' || phase === 'end'))
      endscrlStepTo(mt - endscrlT0, force);
  };
  if (force) {
    for (let guard = 0; guard < 24; guard++) {
      const p0 = phase;
      runPostLnsModules();
      // also re-run pre-PLZ modules that may still be mid-catch-up
      if (lnszoomT0 != null && (phase === 'lnszoom' || phase === 'plzpart'))
        lnszoomStepTo(mt - lnszoomT0, true, (localS) => musplusAtPartLocal(lnszoomT0, localS));
      if (mntscrlT0 != null && (phase === 'mntscrl' || phase === 'lnszoom'))
        mntscrlStepTo(mt - mntscrlT0, true, (localS) => musplusAtPartLocal(mntscrlT0, localS));
      if (panicT0 != null && (phase === 'panic' || phase === 'loadergate' || phase === 'mntscrl'))
        panicStepTo(mt - panicT0, true);
      if (phase === 'techno' || phase === 'panic' || phase === 'loadergate' || phase === 'mntscrl')
        technoStepTo(mt - TECHNO_START, true, chip ? chip.row : null, technoMus);
      stepFrame(mt);
      if (phase === p0) break;
    }
  } else {
    runPostLnsModules();
  }
  if (replay && phase === phaseBefore) {
    replayAll = false;
    if (pendingEraSeek !== null) { applyEraSeek(mt); pendingEraSeek = null; }
  }
  // The live cascade's phase-local origins, i.e. the true part-start demo times
  // the transport labels should be quoting. Each is prevT0 + prevDurationS
  // (chainT0), so this is the whole back-half chain in one line. Logged as soon
  // as the chain is complete (works for ?jump= boots, which never set replayAll).
  if (PHASELOG && !phaselogDone && endscrlT0 != null) {
    phaselogDone = true;
    const t0s = { PANIC: panicT0, MNTSCRL: mntscrlT0, LNSZOOM: lnszoomT0, PLZPART: plzT0,
      MINVBALL: minvT0, RAYSCRL: rayT0, SINFIELD: sinT0, JPLOGO: jpT0, U2E: u2eT0,
      ENDLOGO: endlogoT0, CRED: credT0, ENDSCRL: endscrlT0 };
    console.log('[phase] live T0 chain: ' + Object.entries(t0s)
      .map(([k, v]) => `${k}=${v == null ? '-' : v.toFixed(3)}`).join(' '));
  }
  present();
}

// ---------------------------------------------------------------------------
// The display: an indexed framebuffer through a palette-lookup shader
//
// This is the VGA DAC and nothing else. One triangle covering the screen, an
// 8-bit index plane, a 256x1 palette, and a shader that looks one up in the
// other — so a fade is 768 bytes uploaded and no pixel redrawn, which is the
// whole reason the original could afford its effects on a 486.
//
// Written against WebGL2 directly. A graphics library has nothing to offer a
// program whose entire scene is three vertices.
// ---------------------------------------------------------------------------
let gl, screenCanvas, prog, uCropLoc, idxPlane, endscrlPlane, palTex;
const viewBuf = new Uint8Array(VIEW_W * VIEW_H);

// The screen-filling triangle is built from gl_VertexID, so there are no vertex
// buffers and no attributes at all — three vertices, generated in the shader.
const VERT_SRC = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// uCrop = (v offset, v scale): fullscreen crops the view to the active picture
// band (canvas rows 50..349) so the demo itself fills the screen.
// The palette lookup samples texel centres — index i sits at (i + 0.5)/256.
const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uIdx, uPal;
uniform vec2 uCrop;
out vec4 fragColor;
void main() {
  float v = uCrop.x + (1.0 - vUv.y) * uCrop.y;
  float idx = texture(uIdx, vec2(vUv.x, v)).r;
  fragColor = texture(uPal, vec2(idx * 255.0 / 256.0 + 0.5 / 256.0, 0.5));
}`;

function compileShader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

// One byte per pixel, nearest, clamped — a VGA plane, not a picture.
function makePlane(data, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { tex, data, w, h };
}

function initGL() {
  screenCanvas = document.getElementById('screen');
  gl = screenCanvas.getContext('webgl2', { antialias: false, alpha: false });
  if (!gl) throw new Error('this port needs WebGL2');
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  prog = gl.createProgram();
  gl.attachShader(prog, compileShader(gl.VERTEX_SHADER, VERT_SRC));
  gl.attachShader(prog, compileShader(gl.FRAGMENT_SHADER, FRAG_SRC));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  gl.uniform1i(gl.getUniformLocation(prog, 'uIdx'), 0);   // texture unit 0
  gl.uniform1i(gl.getUniformLocation(prog, 'uPal'), 1);   // texture unit 1
  uCropLoc = gl.getUniformLocation(prog, 'uCrop');
  gl.uniform2f(uCropLoc, 0, 1);

  gl.activeTexture(gl.TEXTURE0);
  idxPlane = makePlane(viewBuf, VIEW_W, VIEW_H);
  endscrlPlane = makePlane(endscrlVram, 640, 400);       // the end scroller is 640 wide

  gl.activeTexture(gl.TEXTURE1);
  palTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, palTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  onResize();
  window.addEventListener('resize', onResize);
  document.addEventListener('fullscreenchange', onResize);
  document.addEventListener('webkitfullscreenchange', onResize);
}

// Upload the live palette and the active plane, then draw the one triangle.
function drawFrame(plane) {
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, palTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, palRGBA);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, plane.tex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, plane.w, plane.h, gl.RED, gl.UNSIGNED_BYTE, plane.data);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
// The board can fullscreen our <iframe> from ITS document — which is how [1] on
// the menu opens straight to full screen, since a navigation would spend the
// gesture the request needs. In that case this document's fullscreenElement
// stays null even though we now own the whole display, so the board tells us.
let hostFullscreen = false;
addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.sr !== 'fs') return;
  if (hostFullscreen === !!e.data.on) return;
  hostFullscreen = !!e.data.on;
  if (gl) onResize();   // it can arrive before initGL(); present() picks up the crop
});
function isFullscreen() {
  return hostFullscreen || !!(document.fullscreenElement || document.webkitFullscreenElement);
}
// fullscreen crop: the raster's own black margins are hidden for the parts
// whose art lives in the picture band (rows 50..349); PAM/BEG use the full
// frame (the white flash masks the geometry change).
function updateCrop(fullContent) {
  if (isFullscreen() && !fullContent) gl.uniform2f(uCropLoc, PICY / VIEW_H, 300 / VIEW_H);
  else gl.uniform2f(uCropLoc, 0, 1);
}
// line-double a 320x200 frame into the 400-row view — exactly what the VGA
// does (double-scanned 200-line mode fills the raster).
function blitDoubled(fb) {
  for (let y = 0; y < 200; y++) {
    const src = fb.subarray(y * 320, (y + 1) * 320);
    viewBuf.set(src, (2 * y) * VIEW_W);
    viewBuf.set(src, (2 * y + 1) * VIEW_W);
  }
}
function uploadAndRender(pal6, plane = idxPlane) {
  for (let i = 0; i < 256; i++) {
    palRGBA[i * 4] = Math.min(255, pal6[i * 3] * 255 / 63);
    palRGBA[i * 4 + 1] = Math.min(255, pal6[i * 3 + 1] * 255 / 63);
    palRGBA[i * 4 + 2] = Math.min(255, pal6[i * 3 + 2] * 255 / 63);
    palRGBA[i * 4 + 3] = 255;
  }
  drawFrame(plane);
}
// U2A: the first frame is pixel-identical to the held panorama view — no fade.
function presentU2A() {
  updateCrop(false);
  blitDoubled(u2aFB);
  uploadAndRender(u2aPalRef);
}
// PAM: FLI frame per 4 vblanks; palette = FLI palette blended toward white by
// the WFADE level for this frame (OUTTAA.C's pal[a*768] table, computed live).
const pamPalBlend = new Uint8Array(768);
function presentPam() {
  updateCrop(true);
  // OUTTAA.C's loop is `while(!dis_exit() && f++<45)`, so the body runs with
  // f = 1..45, and `if(f<=40)` blits an animation frame only for f = 1..40 —
  // the f-th blit shows the f-th frame, i.e. pamFrames[f-1]. pamF counts the
  // 4-vblank ticks from PAM_START and therefore equals f exactly, so indexing
  // pamFrames[pamF] ran one frame ahead the whole way and, at f=41, exposed a
  // 41st frame the demo never displays (PRAX4.FLI holds 41 frames plus the
  // usual FLI ring frame; OUTTAA.C plays only the first 40, then holds frame 40
  // while wfade[41..45] takes the palette back to full white).
  const fi = Math.max(0, Math.min(pamF - 1, PAM_ANIM_FRAMES - 1));
  blitDoubled(pamFrames[fi]);
  const n = WFADE[Math.min(pamF, WFADE.length - 1)];
  for (let i = 0; i < 768; i++) pamPalBlend[i] = (63 * n + (64 - n) * pamPal[i]) >> 6;
  uploadAndRender(pamPalBlend);
}
// BEG: the 320x400 title painting, palette fading from white over 128 vblanks.
const begPalBlend = new Uint8Array(768);
function presentBeg() {
  updateCrop(true);
  viewBuf.set(logoPix);
  const c = begC;
  for (let i = 0; i < 765; i++) begPalBlend[i] = ((128 - c) * 63 + logoPal[i] * c) >> 7;
  begPalBlend[765] = begPalBlend[766] = begPalBlend[767] = 0;   // index 255 stays black
  uploadAndRender(begPalBlend);
}
// GLENZ: title/wipe run in the 320x400 mode (straight into the 400-row view);
// the main scene is 320x200 line-doubled, same as U2A/PAM.
function presentGlenz() {
  updateCrop(true);
  if (glenzMode400()) viewBuf.set(glenzIntroVram);
  else blitDoubled(glenzVram);
  uploadAndRender(glenzDac);
}
// TUNNEL: 320x200 line-doubled; only the visible 64000 bytes of the padded
// vram are shown (the tail is the "offscreen" area OOB dots land in).
function presentTunnel() {
  updateCrop(true);
  blitDoubled(tunnelVram.subarray(0, 64000));
  uploadAndRender(tunnelPal);
}
// TECHNO: box/blob phases are 320x200 line-doubled; the picture reveal runs
// natively in the 400-line mode (like GLENZ's title/wipe), same as glenz.
function presentTechno() {
  updateCrop(true);
  if (technoMode400()) viewBuf.set(technoVram400);
  else blitDoubled(technoVram);
  uploadAndRender(technoPal);
}
// MNTSCRL: 320x200 line-doubled, mode 0x13 chunky (no tweak-mode tricks).
function presentMntscrl() {
  updateCrop(true);
  blitDoubled(mntscrlVram);
  uploadAndRender(mntscrlPal);
}
// LNSZOOM: part1/part2 are 320x200 line-doubled (mode 0x13); part3 (the
// rotozoomer) switches to the native 400-line tweak-mode view, like
// TECHNO's picture reveal.
function presentLnszoom() {
  updateCrop(true);
  if (lnszoomMode400()) viewBuf.set(lnszoomVram400);
  else blitDoubled(lnszoomVram);
  uploadAndRender(lnszoomPal);
}
// PANIC: always native 320x400 (tweak-mode canvas, like TECHNO's picture reveal).
function presentPanic() {
  updateCrop(true);
  viewBuf.set(panicVram);
  uploadAndRender(panicPal);
}
function onResize() {
  const W = window.innerWidth, H = window.innerHeight;
  if (isFullscreen()) {
    // fullscreen: stretch over the whole display (the per-phase updateCrop()
    // hides the raster's own black margins where the art allows it)
    setCanvasSize(W, H);
    return;
  }
  let w = W, h = W * 3 / 4;
  if (h > H) { h = H; w = H * 4 / 3; }
  setCanvasSize(Math.round(w), Math.round(h));
}
// Backing store and CSS box both at 1:1 — the raster is 320 wide, so there is
// nothing for a denser buffer to resolve.
function setCanvasSize(w, h) {
  if (screenCanvas.width !== w || screenCanvas.height !== h) {
    screenCanvas.width = w;
    screenCanvas.height = h;
  }
  screenCanvas.style.width = w + 'px';
  screenCanvas.style.height = h + 'px';
  gl.viewport(0, 0, w, h);
}
const palRGBA = new Uint8Array(256 * 4);
function present() {
  try { document.title = phase + " @" + musicTime().toFixed(1); } catch(e) {}
  if (phase === 'u2a') { presentU2A(); return; }
  if (phase === 'pam') { presentPam(); return; }
  if (phase === 'glenz') { presentGlenz(); return; }
  if (phase === 'tunnel') { presentTunnel(); return; }
  if (phase === 'techno') { presentTechno(); return; }
  if (phase === 'panic' || phase === 'loadergate') { presentPanic(); return; }
  if (phase === 'mntscrl') { presentMntscrl(); return; }
  if (phase === 'lnszoom') { presentLnszoom(); return; }
  if (phase === 'plzpart') {
    // the plasma phase is a native 320x400 mode (see plzpart.js renderPlasma);
    // the vect cube is 320x200 line-doubled
    updateCrop(true);
    if (plzpartMode400()) viewBuf.set(plzpartVram400); else blitDoubled(plzpartVram);
    uploadAndRender(plzpartPal);
    return;
  }
  if (phase === 'minvball') { updateCrop(true); blitDoubled(minvballVram); uploadAndRender(minvballPal); return; }
  if (phase === 'rayscrl') { updateCrop(true); blitDoubled(rayscrlVram); uploadAndRender(rayscrlPal); return; }
  if (phase === 'sinfield') { updateCrop(true); blitDoubled(sinfieldVram); uploadAndRender(sinfieldPal); return; }
  if (phase === 'jplogo') {
    updateCrop(true);
    if (jplogoMode400()) viewBuf.set(jplogoVram); else blitDoubled(jplogoVram);
    uploadAndRender(jplogoPal); return;
  }
  if (phase === 'u2e') {
    updateCrop(true);
    if (u2eMode400()) viewBuf.set(u2eVram400); else blitDoubled(u2eVram);
    uploadAndRender(u2ePal); return;
  }
  if (phase === 'endlogo') {
    updateCrop(true);
    if (endlogoMode400()) viewBuf.set(endlogoVram); else blitDoubled(endlogoVram);
    uploadAndRender(endlogoPal); return;
  }
  // The hidden part is a native 320x400 16-colour mode (mode 0Dh with CRTC 9's
  // scan doubling switched off), so it goes straight into the view.
  if (phase === 'ddstars') { updateCrop(true); viewBuf.set(ddstarsVram); uploadAndRender(ddstarsPal); return; }
  if (phase === 'cred') { updateCrop(true); viewBuf.set(credVram); uploadAndRender(credPal); return; }
  if (phase === 'endscrl') { updateCrop(true); uploadAndRender(endscrlPal, endscrlPlane); return; }
  if (phase === 'beg') { presentBeg(); return; }
  if (phase === 'end') {
    if (endscrlT0 != null) { updateCrop(true); uploadAndRender(endscrlPal, endscrlPlane); }
    else if (lnszoomT0 != null) presentLnszoom();
    else if (mntscrlT0 != null) presentMntscrl();
    else if (panicT0 != null) presentPanic();
    else {
      const t = musicTime();
      (t >= TECHNO_START ? presentTechno : t >= TUNNEL_START ? presentTunnel : t >= GLENZ_START ? presentGlenz : presentBeg)();
    }
    return;
  }
  updateCrop(false);
  // window the virtual canvas: 320x400 at horizontal scroll offset, from canvas
  // row 0 — the ALKU display window fills the whole raster (verified against a
  // capture of the original: picture rows 50..349 sit at 12.5%..87.5% height).
  const scrollX = (cop_start * 4 + (cop_scrl >> 1)) | 0;
  for (let y = 0; y < VIEW_H; y++) {
    const srow = y * FBW, drow = y * VIEW_W;
    for (let x = 0; x < VIEW_W; x++) viewBuf[drow + x] = FB[srow + ((scrollX + x) % FBW)];
  }
  // composite the fixed-position credit overlay on top (text index = bg + tint)
  for (let i = 0; i < viewBuf.length; i++) if (creditOverlay[i]) viewBuf[i] |= creditOverlay[i];
  for (let i = 0; i < 256; i++) {
    palRGBA[i * 4] = Math.min(255, dac[i * 3] * 255 / 63);
    palRGBA[i * 4 + 1] = Math.min(255, dac[i * 3 + 1] * 255 / 63);
    palRGBA[i * 4 + 2] = Math.min(255, dac[i * 3 + 2] * 255 / 63);
    palRGBA[i * 4 + 3] = 255;
  }
  drawFrame(idxPlane);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function loop() { tick(); updateTransport(); requestAnimationFrame(loop); }

async function boot() {
  await loadAssets();
  await Promise.all([
    loadU2A(), loadPam(), loadGlenz(descramble), loadTunnel(), loadTechno(),
    loadPanic(), loadMntscrl(), loadLnszoom(),
    loadPlzpart(), loadMinvball(), loadRayscrl(), loadSinfield(), loadJplogo(),
    loadU2e(), loadEndlogo(), loadCred(), loadEndscrl(), loadDdstars()]);
  // This hidden sequence loops; 128 visited orders covers the complete U2E
  // and ENDLOGO window without allocating the simulator's generic 4000-order
  // safety horizon.
  u2eMusic0Timeline = buildTimeline(musicBytes,
    { startOrder: U2E_MUSIC_ORDER, maxOrders: 128 });
  // MUSIC1 timeline for pre-U2E dis_musplus() gates. music1Bytes is already
  // descrambled by loadGlenz.
  if (music1Bytes) {
    music1Timeline = buildTimeline(music1Bytes);
    const rows = music1Timeline.rows;
    if (rows.length) {
      const last = rows[rows.length - 1];
      // one row lasts speed ticks × 2.5/tempo seconds
      music1DurationS = last.t + last.speed * 2.5 / last.tempo;
    }
  }
  setupPalettes();
  initGL();
  setDAC(fade1);          // start black
  initTransport();
  const overlay = document.getElementById('overlay');

  // ?part=<name> starts from that part; ?jump=<seconds> from that second. The
  // constants partsList() reads are all initialised by now, which is why this is
  // resolved here rather than beside the DEBUG block.
  const bootAt = PART_JUMP ? (slugTime(PART_JUMP) ?? 0) : JUMP;

  // `SECOND U`: run the hidden part and nothing else. The phase chain is never
  // entered, so none of the demo's parts load or gate — which is exactly what
  // partsmask[8] = 80h does, since bit 7 is the only bit it sets.
  if (HIDDEN) {
    overlay.style.display = 'none';
    document.getElementById('startNote')?.remove();
    ddstarsReset();
    phase = 'ddstars';
    if (SILENT) {
      musicReady = true;
      silentStart = performance.now() / 1000;
      ddstarsT0 = 0;
    } else {
      await startMusic();
      // MUSIC0 order 70: an eight-pattern section fenced off by 255 end-markers
      // that nothing else in the demo starts at.
      try { chip.setOrderRow(HIDDEN_MUSIC_ORDER, 0); } catch { /* no seek, still runs */ }
      activeMod = 0;
      activeModuleOriginMt = musicTime();
      ddstarsT0 = musicTime();
      // Autoplay refused: the clock is not advancing, so anchor the part's origin
      // when it does. The demo has no black opening here to hide behind.
      if (musicCtx.state !== 'running') {
        overlay.style.display = '';
        overlay.classList.add('ready');
        overlay.querySelector('.msg').textContent = 'PRESS ANY KEY';
        const go = async () => {
          try { await musicCtx.resume(); } catch { /* let them try again */ }
          if (musicCtx.state !== 'running') return;
          musicStart = musicCtx.currentTime;
          ddstarsT0 = 0;
          overlay.style.display = 'none';
          removeEventListener('keydown', go); removeEventListener('pointerdown', go);
        };
        addEventListener('keydown', go);
        addEventListener('pointerdown', go);
      }
    }
    console.log('[DDSTARS] SECOND U — the hidden part, on MUSIC0 from order ' +
                HIDDEN_MUSIC_ORDER + '. It ends when you leave, as dis_exit did.');
    loop();
    return;
  }

  if (SILENT) {
    overlay.style.display = 'none';
    musicReady = true; silentStart = performance.now() / 1000;
    if (PART_JUMP && bootAt > 0) jumpTo(bootAt);   // ?jump= is already in musicTime()
    loop();
    return;
  }

  // Tell them to turn the volume up, and that the black opening is intentional.
  // Keyed to the demo's own clock rather than a wall timer, so it stays put while
  // the audio context is suspended and the clock is not advancing.
  //
  // Starting mid-demo there is no black opening to explain, and no first title
  // card coming to retire the note either — so drop it rather than hide it. (The
  // element's own `display:flex` outranks the `hidden` attribute, so hiding it is
  // not actually available.)
  const note = document.getElementById('startNote');
  if (note && bootAt > 0) {
    note.remove();
  } else if (note) {
    note.hidden = false;
    const watch = setInterval(() => {
      if (musicTime() < CARD_START[0]) return;
      clearInterval(watch);
      note.style.opacity = '0';
      setTimeout(() => note.remove(), 1600);
    }, 250);
  }

  // Just start. Arriving here from the board is a user gesture, and Chrome
  // propagates that activation into this frame, so the audio context usually
  // comes up running and nothing needs clicking.
  await startMusic();
  if (musicCtx.state === 'running' && bootAt > 0) jumpTo(bootAt);
  loop();

  if (musicCtx.state === 'running') { overlay.style.display = 'none'; return; }

  // The browser refused autoplay — a cold visit with no prior interaction on
  // this origin. Ask, but take ANY key or a click anywhere rather than
  // demanding a hit on the overlay itself. The clock is anchored on resume, so
  // the demo starts from its first frame whenever that happens; while the
  // context is suspended currentTime does not advance and the screen just
  // holds black, which is what the demo opens with anyway.
  overlay.classList.add('ready');
  overlay.querySelector('.msg').textContent = 'PRESS ANY KEY';
  const resume = async () => {
    try { await musicCtx.resume(); } catch { /* ignore and let them try again */ }
    if (musicCtx.state !== 'running') return;
    musicStart = musicCtx.currentTime;
    if (bootAt > 0) jumpTo(bootAt);       // anchor first, then seek to the target
    overlay.style.display = 'none';
    removeEventListener('keydown', resume);
    removeEventListener('pointerdown', resume);
  };
  addEventListener('keydown', resume);
  addEventListener('pointerdown', resume);
}
boot();
