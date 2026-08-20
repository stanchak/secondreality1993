// Validates s3msim.js against GLENZ's already-shipped, independently-derived
// gate constants (glenz.js: MFRAME0_S=6.5187, 2600-vblank part span) before the
// simulator is trusted to derive any NEW gate for TECHNO/MNTSCRL/etc.
// Run: node tools/validate_s3msim.mjs   (from unreal2/, or anywhere --
// paths below are resolved relative to this file)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { descramble, buildTimeline, musplusAt, timeAtRow, firstTimeWhere, rowAtTime } from '../s3msim.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const musicPath = join(HERE, '..', 'assets', 'music1.s3m');

let failures = 0;
function check(name, actual, expected, tol) {
  const ok = Math.abs(actual - expected) <= tol;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: actual=${actual} expected=${expected} (tol ${tol})`);
  if (!ok) failures++;
}

const raw = readFileSync(musicPath);
const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const descrambled = descramble(ab);
const tl = buildTimeline(descrambled);

// Check 1 -- elapsed-time to MUSIC1 order 2/row 45 (glenz.js: "row 45 of
// MUSIC1 order 2 = 6.5187 s into the song, computed with libopenmpt").
const t45 = timeAtRow(tl, 2, 45);
check('timeAtRow(order=2,row=45)', t45, 6.5187, 0.001);

// Check 2 -- musplusAt formula at that exact position (glenz.js: "fires
// when musplus first returns >= -19").
const mp45 = musplusAt(tl.order, 2, 45);
check('musplusAt(order=2,row=45)', mp45, -19, 0);

// Check 3 -- part-end cross-check. GLENZ exits on MAIN.C's own music gate
// (`a=dis_musplus(); if(a<0 && a>-16) break;`), which sits GLENZ_TOTAL_FRAMES =
// 2600 vblanks after MFRAME0_S: that exit fires when musplus re-enters (-16,0),
// "15 rows before the second +++ marker". glenz.js splits those 2600 into
// MAIN_START (the mframe-gated wipe/bounce/hand-off span, mframeToVblank(333)+1
// = 446 at MFRAME_HZ=52.4) plus END_FRAME (the main loop's own 2154). The SPLIT
// is what the mframe-rate fix changed; the TOTAL is what this pins,
// so this check stays valid across that change and would catch any drift in it.
const MFRAME0_S = 6.5187, GLENZ_TOTAL_FRAMES = 2600;
const GLENZ_MAIN_START = 446;
const mainLoopStart = MFRAME0_S + GLENZ_MAIN_START / 70;
const expectedExit = MFRAME0_S + GLENZ_TOTAL_FRAMES / 70;
const found = firstTimeWhere(tl, mainLoopStart, m => m > -16 && m < 0);
if (found) {
  check('firstTimeWhere exit (-16,0) after main-loop start', found.t, expectedExit, 1 / 70);
  console.log(`      -> order=${found.orderIdx} row=${found.row} musplus=${found.musplus}`);
} else {
  console.log('FAIL  firstTimeWhere exit (-16,0): no match found');
  failures++;
}

// Sanity: the "second +++" marker should sit at order index 14 (order list
// index verified directly against the raw file), so the ramp
// found above should be happening in order 13 (immediately before it).
check('exit ramp order index', found ? found.orderIdx : -1, 13, 0);

// MAIN/STARTMUS.C patches MUSIC0 byte 50 (initial tempo) to 0x78, then
// MAIN/U2.ASM restarts the module at hidden order 18 for U2E. The normal
// order-zero path ends at index 16, so this must be a direct-entry timeline.
const music0Path = join(HERE, '..', 'assets', 'music0.s3m');
const music0Raw = readFileSync(music0Path);
const music0Ab = music0Raw.buffer.slice(music0Raw.byteOffset,
  music0Raw.byteOffset + music0Raw.byteLength);
new Uint8Array(music0Ab)[50] = 0x78;
const u2eTl = buildTimeline(descramble(music0Ab), { startOrder: 18, maxOrders: 128 });
check('U2E hidden timeline starts at order 18', u2eTl.rows[0]?.orderIdx ?? -1, 18, 0);
const u2eGate = rowAtTime(u2eTl, 4);
check('U2E order gate reaches order 19 at patched-tempo 4.0s',
  u2eGate?.orderIdx ?? -1, 19, 0);
check('U2E order gate enters at row 0', u2eGate?.row ?? -1, 0, 0);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
