// RAYSCRL — direct port of WATER/DEMO.PAS + WATER/ROUTINES.ASM.
//
// The original uses three DATGEN-produced sparse offset streams.  Each of
// their 158*34 records corresponds to one byte of the rolling fbuf; a zero
// fbuf byte restores the background at every listed VGA offset.  It is not a
// conventional font blit.

const VBLANK_HZ = 70;
const WIDTH = 320;
const HEIGHT = 200;
const CELLS = 158 * 34;
const FBUF_SIZE = CELLS + 1; // Pascal declaration: array[0..158*34]

export const rayscrlVram = new Uint8Array(WIDTH * HEIGHT);
export const rayscrlPal = new Uint8Array(768);

let background = null;
let targetPalette = null;
let font = null;
let wat = null;

let workPalette = new Uint8Array(769);
let blackPalette = new Uint8Array(769);
let fbuf = new Uint8Array(FBUF_SIZE);
let phase = 'prewait';
let localFrame = -1;
let fadeY = 0;
let sss = 0;
let scp = 0;
let fp = 0;
let done = false;
let doneAtLocal = null;
let entryOrder = null;
let inferredRowGateS = Infinity;

function u16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function assertRix3(bytes, width, height, name) {
  if (bytes.length < 778 || bytes[0] !== 0x52 || bytes[1] !== 0x49 ||
      bytes[2] !== 0x58 || bytes[3] !== 0x33 ||
      u16(bytes, 4) !== width || u16(bytes, 6) !== height) {
    throw new Error(`${name}: expected a RIX3 ${width}x${height} image`);
  }
}

// DATGEN.PAS writes, for every fbuf cell, a word count followed by that many
// word VGA offsets.  Compile it once into two typed arrays but preserve the
// exact record order consumed by Putrouts1.
function decodeWat(bytes, name) {
  const starts = new Uint32Array(CELLS + 1);
  const offsets = [];
  let p = 0;
  for (let cell = 0; cell < CELLS; cell++) {
    if (p + 2 > bytes.length) throw new Error(`${name}: truncated count at cell ${cell}`);
    const count = u16(bytes, p); p += 2;
    starts[cell] = offsets.length;
    if (p + count * 2 > bytes.length)
      throw new Error(`${name}: truncated offset list at cell ${cell}`);
    for (let i = 0; i < count; i++, p += 2) {
      const offset = u16(bytes, p);
      if (offset >= WIDTH * HEIGHT) throw new Error(`${name}: VGA offset ${offset} out of range`);
      offsets.push(offset);
    }
  }
  starts[CELLS] = offsets.length;
  if (p !== bytes.length) throw new Error(`${name}: ${bytes.length - p} trailing bytes`);
  return { starts, offsets: Uint16Array.from(offsets) };
}

async function bytesFrom(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function loadRayscrl() {
  const [bkg, miekka, wat1, wat2, wat3] = await Promise.all([
    bytesFrom('assets/ray_bkg.clx'),
    bytesFrom('assets/ray_miekka.sci'),
    bytesFrom('assets/ray_wat1.dat'),
    bytesFrom('assets/ray_wat2.dat'),
    bytesFrom('assets/ray_wat3.dat'),
  ]);
  assertRix3(bkg, 320, 200, 'WATER/BKG.CLX');
  assertRix3(miekka, 400, 250, 'WATER/MIEKKA.SCI');
  if (bkg.length !== 778 + 64000) throw new Error(`WATER/BKG.CLX: ${bkg.length} bytes`);
  if (miekka.length < 778 + 400 * 34) throw new Error(`WATER/MIEKKA.SCI: ${miekka.length} bytes`);

  // DEMO.PAS intentionally takes its palette from MIEKKA, not BKG.
  targetPalette = new Uint8Array(769);
  targetPalette.set(miekka.subarray(10, 778));
  font = miekka.slice(778, 778 + 400 * 34);
  background = bkg.slice(778, 778 + 64000);
  wat = [decodeWat(wat1, 'WAT1.DAT'), decodeWat(wat2, 'WAT2.DAT'),
         decodeWat(wat3, 'WAT3.DAT')];
  console.log('[RAYSCRL] original BKG/MIEKKA/WAT1-3 assets loaded');
}

function musicPosition(sample) {
  if (sample && typeof sample === 'object') {
    return {
      musplus: Number(sample.musplus ?? sample.plus ?? -32),
      row: Number.isFinite(sample.row) ? sample.row : null,
      order: Number.isFinite(sample.order) ? sample.order :
             (Number.isFinite(sample.orderIdx) ? sample.orderIdx : null),
    };
  }
  return { musplus: Number(sample ?? -32), row: null, order: null };
}

// DEMO.PAS also reads the order and row returned by int FC/bx=6. main.js uses
// that exact object callback. Keep the numeric-only inference for standalone
// callers: during the post-marker order, musplus is row 0..31, so its slope
// projects to next-order row 16 (80 rows after row 0).
function inferRowGate(sampleAt, now) {
  if (!sampleAt) return now + 80 * 4 / VBLANK_HZ;
  const step = 1 / (VBLANK_HZ * 8);
  const from = Math.max(0, now - 3);
  const to = now + 3;
  const first = new Map();
  let inTargetRamp = false;
  let last = -32;
  for (let t = from; t <= to; t += step) {
    const m = musicPosition(sampleAt(t)).musplus;
    if (m >= 0 && m < 32) {
      if (!inTargetRamp && (last < 0 || m < last)) first.clear();
      inTargetRamp = true;
      if (!first.has(m)) first.set(m, t);
    } else if (inTargetRamp) {
      // Keep the ramp that contains `now`; a later one is not WATER's entry.
      if (t >= now && first.size >= 2) break;
      inTargetRamp = false;
      first.clear();
    }
    last = m;
  }
  const points = [...first].sort((a, b) => a[0] - b[0]);
  if (points.length < 2) return now + 80 * 4 / VBLANK_HZ;
  const n = points.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [row, time] of points) {
    sx += row; sy += time; sxx += row * row; sxy += row * time;
  }
  const rowSeconds = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const rowZero = (sy - rowSeconds * sx) / n;
  return rowZero + 80 * rowSeconds;
}

export function rayscrlReset() {
  phase = 'prewait';
  localFrame = -1;
  fadeY = 0;
  sss = 0;
  scp = 0;
  fp = 0; // Pascal global/static storage starts at zero.
  done = false;
  doneAtLocal = null;
  entryOrder = null;
  inferredRowGateS = Infinity;
  workPalette = new Uint8Array(769);
  blackPalette = new Uint8Array(769);
  fbuf = new Uint8Array(FBUF_SIZE);
  rayscrlVram.fill(0); // BIOS mode 13h clear while the initial gate spins.
  rayscrlPal.fill(0);
}

function uploadPalette() {
  rayscrlPal.set(workPalette.subarray(0, 768));
}

// Preserve the Pascal `pf := 0 to 3` bug.  Index 3 is the next colour's red
// channel, so most red entries are adjusted twice per palette pass.
function movePaletteToward(target, direction) {
  for (let x = 0; x < 256; x++) {
    const base = x * 3;
    for (let pf = 0; pf <= 3; pf++) {
      const i = base + pf;
      if (direction > 0) {
        if (workPalette[i] < target[i]) workPalette[i]++;
      } else if (workPalette[i] > target[i]) {
        workPalette[i]--;
      }
    }
  }
}

function sparseScreen(stream) {
  const { starts, offsets } = stream;
  for (let cell = 0; cell < CELLS; cell++) {
    const foreground = fbuf[cell];
    for (let i = starts[cell]; i < starts[cell + 1]; i++) {
      const dst = offsets[i];
      rayscrlVram[dst] = foreground || background[dst];
    }
  }
}

function scrAndAdvance(scroll) {
  sparseScreen(wat[sss]);
  if (!scroll) {
    sss = sss === 2 ? 0 : sss + 1;
    return;
  }
  if (sss === 2) {
    sss = 0;
    // Turbo Pascal MOVE is an overlapping forward copy here.  The final
    // destination byte is overwritten by the row-33 insertion and never read
    // by Putrouts1, so copyWithin reproduces all observable bytes.
    fbuf.copyWithin(0, 1);
    for (let row = 0; row < 34; row++) fbuf[158 + row * 158] = font[row * 400 + scp];
    if (scp < 390) scp++;
  } else {
    sss++;
  }
}

function startPicture(sampleAt, now, position) {
  rayscrlVram.set(background);
  workPalette.fill(0);
  rayscrlPal.fill(0);
  fbuf.fill(0);
  fadeY = 0;
  sss = 0;
  entryOrder = position.order;
  // The ~3.4k-probe inference is a fallback for numeric-only callbacks
  // (standalone harnesses); main.js supplies exact order/row, where running
  // it anyway cost a visible hitch inside the entry frame.
  inferredRowGateS = position.order === null ? inferRowGate(sampleAt, now) : Infinity;
  phase = 'fade';
}

function stepOne(sampleAt) {
  const now = localFrame / VBLANK_HZ;
  const position = musicPosition(sampleAt ? sampleAt(now) : 0);

  if (phase === 'prewait') {
    if (position.musplus < 0) return;
    startPicture(sampleAt, now, position);
  }

  if (phase === 'fade') {
    // `for y := 0 to 63*2` is inclusive: 127 vblanks/screens.
    if (fadeY & 1) {
      uploadPalette();
      movePaletteToward(targetPalette, 1);
    }
    scrAndAdvance(false);
    if (fadeY++ === 126) {
      phase = 'rowwait';
      sss = 0;
    }
    return;
  }

  if (phase === 'rowwait') {
    const exactGate = entryOrder !== null && position.order !== null &&
      position.order !== entryOrder && position.row !== null && position.row >= 16;
    if (!exactGate && !(position.order === null && now >= inferredRowGateS)) return;
    sss = 0;
    scp = 0;
    phase = 'main';
  }

  if (phase === 'main') {
    if (position.musplus === -11) phase = 'fadeout';
    if (phase === 'main') {
      scrAndAdvance(true);
      return;
    }
  }

  if (phase === 'fadeout') {
    // DEMO.PAS sets quit only when fp was already 64, hence 65 iterations.
    const quit = fp === 64;
    if (!quit) fp++;
    uploadPalette();
    movePaletteToward(blackPalette, -1);
    scrAndAdvance(true);
    if (quit) {
      done = true;
      doneAtLocal = now;
      phase = 'done';
    }
  }
}

export function rayscrlEnded() { return done; }
export function rayscrlLocalFrames() { return localFrame; }
export function rayscrlDurationS() {
  return doneAtLocal ?? Math.max(0, localFrame) / VBLANK_HZ;
}

export function rayscrlStepTo(tt, replay, musplusAtLocal) {
  if (done) return false;
  const target = Math.floor(tt * VBLANK_HZ);
  let steps = target - localFrame;
  if (steps <= 0) return true;
  if (steps > 35 && !replay) steps = 35;
  for (let i = 0; i < steps && !done; i++) {
    localFrame++;
    stepOne(musplusAtLocal);
  }
  return !done;
}
