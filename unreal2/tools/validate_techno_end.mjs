#!/usr/bin/env node

// Deterministic end-timing + phase-structure regression check for
// unreal2/techno.js.
//
// Drives the real module exactly the way main.js does in a silent/replay run:
// technoStepTo(localSeconds, replay=true, liveRow=null, musplusAtLocal) one
// vblank at a time, with musplusAtLocal backed by the same s3msim MUSIC1
// timeline main.js builds (MUSIC1 elapsed = demo - GLENZ_START; TECHNO_START
// = 152.17 + 1060/70 = 167.3129 demo-seconds).
//
// What it locks down (all derived in techno.js, see its header):
//  - dointerference2 (IF2) runs exactly 256 vblanks after the 49-frame prewait
//  - the dointerference blob runs exactly 987 vblanks (measured WOBBLE_END)
//  - doit1/doit2/doit3 chain: DOIT3_BOX_END - wedgeEnd == 420+840+701
//  - tail: HOLD_END - DOIT3_BOX_END == 53+50+420 == 523
//  - the part end lands at demo ~= 224 (223.5..224.5), matching the
//    reference-video troll-hold end (~225.07 video ~= ~224 demo) and the
//    live-audio TECHNO->PANICEND measurement (mt ~= 223.6),
//    i.e. the doit3-exit music gate order>35||(order==35&&row>48) at
//    MUSIC1-abs t=108.231s (demo 216.73) + reveal/ripple + 420-frame hold.
//
// Usage: node validate_techno_end.mjs [path-to-techno.js]
// (the optional arg lets the same harness measure a saved pre-fix copy)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');

// Browser fetch shim for loadTechno()'s asset loads.
globalThis.fetch = async url => {
  const p = path.join(webRoot, url);
  if (url.endsWith('.json')) {
    return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(p, 'utf8')) };
  }
  const b = fs.readFileSync(p);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return { ok: true, status: 200, arrayBuffer: async () => ab };
};

const { descramble, buildTimeline, musplusAtTime } =
  await import(pathToFileURL(path.join(webRoot, 's3msim.js')).href);

// --- MUSIC1 timeline, exactly as main.js builds it -------------------------
const m1buf = fs.readFileSync(path.join(webRoot, 'assets', 'music1.s3m'));
const m1ab = descramble(m1buf.buffer.slice(m1buf.byteOffset, m1buf.byteOffset + m1buf.byteLength));
const timeline = buildTimeline(m1ab);

const VBLANK_HZ = 70;
// Mirror of main.js's derivation — keep these in step with it. GLENZ_START is
// the MUSIC1 switch, which MAIN/U2.ASM:810-820 performs (restartmus) the instant
// BEGLOGO's main() returns, so it is the sum of the parts' own source-coded
// vblank counts, not a capture measurement. Note that M1_AT_TECHNO0
// — and therefore every music gate this file checks — is INVARIANT under the
// GLENZ_START change, because TUNNEL_START moves with it; only the absolute demo
// times (gateDemo / endDemo / boxEndDemo) shift.
const PAM_START = 104.125;                              // dis_sync()>=10, ord13 row1
const BEG_FADE_START = PAM_START + (180 + 32) / VBLANK_HZ;
const GLENZ_START = BEG_FADE_START + 129 / VBLANK_HZ;   // 108.9964 demo-s
const GLENZ_END_MUSIC1 = 6.5187 + (333 + 2267) / VBLANK_HZ;
const TUNNEL_START = GLENZ_START + GLENZ_END_MUSIC1;    // 152.6580 demo-s
const TECHNO_START = TUNNEL_START + 1060 / VBLANK_HZ;   // 167.8008 demo-s
const M1_AT_TECHNO0 = TECHNO_START - GLENZ_START;       // MUSIC1 elapsed at techno-local 0
const musLocal = localS => musplusAtTime(timeline, M1_AT_TECHNO0 + localS);

// --- documented doit3-exit gate, re-derived from the timeline --------------
// KOE.C:638-648: int 0fch bx=6 -> CX=order idx, BX=row; break on
// a>35 || (a==35 && b>48). First-true time must be MUSIC1-abs ~108.231s.
let gateT = null;
for (const r of timeline.rows) {
  if (r.orderIdx > 35 || (r.orderIdx === 35 && r.row > 48)) { gateT = r.t; break; }
}
assert.ok(gateT !== null, 'doit3-exit gate row must exist in MUSIC1 timeline');
// The documented gate time is 108.231 (row 48's start); row>48 first READS true one
// row later, at row 49's start — same gate, one-row (0.0577s) quantization.
assert.ok(Math.abs(gateT - 108.231) < 0.08,
  `doit3-exit gate must sit at MUSIC1-abs ~108.231s (got ${gateT.toFixed(3)})`);
const gateDemo = gateT + GLENZ_START;                    // ~216.73 demo-s

// --- drive the module one vblank at a time ---------------------------------
const target = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(webRoot, 'techno.js');
const techno = await import(`${pathToFileURL(target).href}?validation=${Date.now()}`);
await techno.loadTechno();
techno.technoReset();

// NOTE: the prewait musplus gate may open before frame 49; techno.js then
// JUMPS its frame counter to PREWAIT_FRAMES to keep the chain aligned — so
// iterations and local frames are not 1:1. Key everything off the module's
// own frame counter, deduped.
const sig = [];   // one observable signature per unique local frame
const MAX_FRAMES = 6000;
for (let f = 0; f < MAX_FRAMES; f++) {
  techno.technoStepTo((f + 0.5) / VBLANK_HZ, true, null, musLocal);
  const lf = techno.technoLocalFrames();
  if (sig.length && sig[sig.length - 1].f >= lf) { if (techno.technoEnded()) break; continue; }
  const vram = techno.technoVram, pal = techno.technoPal;
  let max = 0, has254 = false;
  if (!techno.technoMode400()) {
    for (let i = 0; i < vram.length; i++) {
      const v = vram[i];
      if (v === 254) has254 = true;
      if (v > max) max = v;
    }
  }
  sig.push({
    f: lf,
    max, has254,
    palHi: pal[8 * 3] !== 0,                                   // KOEA_PAL2 entries live (wobble)
    wedgeBg: has254,                                           // the wedge's colour-15 canvas is up
    bg254: [pal[254 * 3], pal[254 * 3 + 1], pal[254 * 3 + 2]].join(','),
    pal0: [pal[0], pal[1], pal[2]].join(','),
    v0: techno.technoMode400() ? -1 : vram[0],
    mode400: techno.technoMode400(),
  });
  if (techno.technoEnded()) break;
}
assert.ok(techno.technoEnded(), 'part must end within the frame budget');
for (let i = 1; i < sig.length; i++) {
  assert.ok(sig[i].f === sig[i - 1].f + 1 || (sig[i - 1].f < 49 && sig[i].f === 49),
    `frame counter must advance one vblank at a time (${sig[i - 1].f} -> ${sig[i].f})`);
}

// --- locate observable phase boundaries ------------------------------------
const first = pred => { const s = sig.find(pred); return s ? s.f : -1; };
const if2Start = first(s => s.max > 0);                        // prewait -> dointerference2
const wobbleStart = first(s => s.palHi);                       // IF2 -> blob (KOEA pal2 written)
const wedgeBgStart = first(s => s.wedgeBg);                    // blob -> wedge backdrop (WOBBLE_END)
const bar0Start = first(s => s.wedgeBg && s.f >= wedgeBgStart && s.v0 === 0);  // first bar grows
const doit1Start = first(s => s.f > bar0Start && !s.has254 && s.max >= 1 && s.max <= 4);
const mode400Start = first(s => s.mode400);                    // DOIT3_BOX_END
const endFrames = techno.technoEndFrames();                    // HOLD_END
const endDemo = TECHNO_START + endFrames / VBLANK_HZ;
const boxEndDemo = TECHNO_START + mode400Start / VBLANK_HZ;

console.log(`gate  order>35||(order==35&&row>48): MUSIC1-abs ${gateT.toFixed(3)}s = demo ${gateDemo.toFixed(3)}`);
console.log(`if2Start=${if2Start}  wobbleStart=${wobbleStart}  wedgeBgStart=${wedgeBgStart}`);
console.log(`bar0Start=${bar0Start}  doit1Start=${doit1Start}  DOIT3_BOX_END=${mode400Start} (demo ${boxEndDemo.toFixed(3)})`);
console.log(`HOLD_END=${endFrames} -> part end demo ${endDemo.toFixed(3)}  (techno-local ${(endFrames / VBLANK_HZ).toFixed(2)}s)`);

// --- intermediate structure (must be unchanged) ----------------------------
assert.equal(if2Start, 49, 'PREWAIT_FRAMES: 49 black vblanks before IF2');
assert.equal(wobbleStart - if2Start, 256, 'dointerference2 must run exactly 256 vblanks');
// WOBBLE_END = wobbleStart+987 is the measured end of the blob's TEXTURE, which
// is where koe.c's flash(-1)/32/64/192/256 ramp starts — 4 vblanks that whiten
// the blob out while it is still the picture on screen, before the mode switch
// puts up the wedge's colour-15 canvas. So the canvas appears 4 frames later.
const WHITE_FLASH_FRAMES = 4;
assert.equal(wedgeBgStart - wobbleStart, 987 + WHITE_FLASH_FRAMES,
  'blob texture must end at IF2_END+987 (measured WOBBLE_END), then 4 white-flash vblanks');
{
  const w0 = wobbleStart + 987;
  const flash = sig.filter(s => s.f >= w0 && s.f < w0 + WHITE_FLASH_FRAMES);
  assert.equal(flash.length, WHITE_FLASH_FRAMES, 'white flash must occupy 4 vblanks');
  assert.ok(flash.every(s => !s.wedgeBg && s.max > 4),
    'the blob raster must still be on screen during the white flash');
  const lum = flash.map(s => s.pal0.split(',').map(Number)[0]);
  assert.ok(lum[0] < lum[1] && lum[1] < lum[2] && lum[2] <= lum[3] && lum[3] === 63,
    `white flash must ramp DAC entry 0 up to 63, got ${lum.join(',')}`);
}
// koe.c overwrites flash()'s pal1 with a*6/2, a*7/2, a*8/2 before the wedge, so
// once a bar's growth has run the fade out (flash(0)), entry 15 sits at 45,52,60.
assert.ok(sig.some(s => s.wedgeBg && s.bg254 === '45,52,60'),
  'wedge background must settle on pal1[15] = (45,52,60)');
assert.ok(sig.some(s => s.wedgeBg && s.bg254 === '63,63,63'),
  'wedge must hold full white through its pre-bar music gates');
assert.ok(doit1Start > bar0Start && bar0Start > wedgeBgStart, 'wedge must run between blob and doit1');
assert.ok(doit1Start - wedgeBgStart >= 104 && doit1Start - wedgeBgStart <= 350,
  `wedge span plausible (4x(21+4) + beat waits), got ${doit1Start - wedgeBgStart}`);
assert.equal(mode400Start - doit1Start, 420 + 840 + 701,
  'doit1(420) + doit2(840) + doit3 box/wipe(701) chain must be intact');
assert.equal(endFrames - mode400Start, 53 + 50 + 420,
  'tail must be wipe-in(53) + ripple(50) + HOLD budget(420)');

// --- the regression check itself -------------------------------------------
assert.ok(endDemo >= 223.5 && endDemo <= 224.5,
  `part end must land at demo ~224 (video 225.07 - ~1s timebase; live mt 223.6): got ${endDemo.toFixed(3)}`);
assert.ok(Math.abs(boxEndDemo - gateDemo) <= 0.5,
  `doit3 exit must land on its music gate (demo ${gateDemo.toFixed(2)}): got ${boxEndDemo.toFixed(3)}`);

console.log('TECHNO end-timing validation passed: phase chain intact, doit3 exits on its music gate, part ends at demo ~224');
