// JPLOGO — exact browser port of JPLOGO/JP.C + ASM.ASM + generated ZOOM.INC.
// The packed picture is extracted from the linked _PIC.OBK by
// tools/extract_post_minv_assets.mjs; its OMF LEDATA offsets are significant.

const VBLANK_HZ = 70;
const trunc = Math.trunc;

export const jplogoVram = new Uint8Array(320 * 400);
export const jplogoPal = new Uint8Array(768);

let sin1024 = null;
let rows = null;
let atRest = null;
let framey1t = null;
let framey2t = null;
let localFrame = 0;
let state = 'setup-wait-1';
let scrollY = 400 * 64;
let scrollA = 64;
let jellyFrame = 0;
let done = false;
let doneAtLocal = null;

function decodePackedPicture(d) {
  const u16 = o => d[o] | (d[o + 1] << 8);
  const width = u16(2), height = u16(4), colors = u16(6), dataOffset = u16(8) * 16;
  if (width !== 320 || height !== 400 || colors !== 256)
    throw new Error(`JPLOGO packed-picture header ${width}x${height}/${colors}`);
  const palette = d.slice(16, 16 + colors * 3);
  const pixels = new Uint8Array(width * height);
  let p = dataOffset;
  for (let y = 0; y < height; y++) {
    if (p + 2 > d.length) throw new Error(`JPLOGO truncated before row ${y}`);
    const bytes = u16(p); p += 2;
    const end = p + bytes;
    let out = y * width;
    while (p < end) {
      const tag = d[p++];
      if (tag & 0x80) {
        const count = (tag & 0x7f) || 256;   // 0x80 = run of 256, not 0
        const value = d[p++];
        pixels.fill(value, out, out + count);
        out += count;
      } else {
        pixels[out++] = tag;
      }
    }
    if (p !== end || out !== (y + 1) * width)
      throw new Error(`JPLOGO corrupt packed row ${y}`);
  }
  return { palette, pixels };
}

// Exact output of DOL.C/ZOOM.INC: requested widths 2..138 use zoom140,
// widths 246..318 use zoom244, and each inclusive destination span samples
// 185 source bytes (184 image bytes plus row[184] = sentinel colour 65).
function linezoom(dst, row, requestedWidth) {
  jplogoVram.fill(0, dst, dst + 320);
  if (!row || requestedWidth === 0) return;
  const width = Math.max(140, Math.min(244, requestedWidth & ~1));
  const left = 160 - (width >> 1);
  const right = 160 + (width >> 1);
  const count = right - left + 1;
  for (let x = left; x <= right; x++) {
    const source = trunc(((x - left) * 185 + (count >> 1)) / count);
    jplogoVram[dst + x] = row[source];
  }
}

function buildBounceTables() {
  const fy1 = new Int32Array(200);
  const fy2 = new Int32Array(200);
  let y1 = 0, y1a = 500, y2 = 399 * 16, y2a = 500;
  let mika = 1, halt = false;
  // JP.C has just completed `for(a=0;a<200;a++)`, so a is 200 here.
  let a = 200;
  for (let frame = 0; frame < 200; frame++) {
    if (!halt) {
      y1 += y1a;
      y2 += y2a;
      y2a += 16;
      if (y2 > 400 * 16) {
        y2 -= y2a;
        y2a = trunc((-y2a * mika) / 8);
        if (mika < 4) mika += 3;
      }
      y1a += 16;
      const la = a;
      a = (y2 - y1) - 400 * 16;
      if ((a & 0x8000) ^ (la & 0x8000)) y1a = trunc((y1a * 7) / 8);
      y1a += trunc(a / 8);
      y2a -= trunc(a / 8);
    }
    if (frame > 90) {
      if (y2 >= 399 * 16) { y2 = 400 * 16; halt = true; }
      else y2a = 8;
      y1 = y2 - 400 * 16;
    }
    fy1[frame] = y1;
    fy2[frame] = y2;
  }
  framey1t = new Int32Array(800);
  framey2t = new Int32Array(800);
  for (let i = 0; i < 800; i++) {
    const b = trunc(i / 4), c = i & 3, d = 3 - c;
    // Only entries through 511 are consumed. Keep the historical out-of-range
    // tail deterministic without changing any frame the executable displays.
    const next = Math.min(199, b + 1);
    framey1t[i] = trunc((fy1[Math.min(b, 199)] * d + fy1[next] * c) / 3);
    framey2t[i] = trunc((fy2[Math.min(b, 199)] * d + fy2[next] * c) / 3);
  }
}

export async function loadJplogo() {
  const [tables, packed] = await Promise.all([
    fetch('assets/tables.json').then(r => r.json()),
    fetch('assets/jplogo.up').then(r => r.arrayBuffer()),
  ]);
  // JPLOGO/SIN1024.INC clamps the peak at ±255 (the shared tables.json copy
  // reaches ±256 at indices 256/768) — clamp to match the linked table.
  sin1024 = Int16Array.from(tables.sin1024, v => v > 255 ? 255 : v < -255 ? -255 : v);
  const picture = decodePackedPicture(new Uint8Array(packed));
  jplogoPal.set(picture.palette);
  jplogoPal.fill(0, 64 * 3, 64 * 3 + 3);

  rows = Array.from({ length: 400 }, () => new Uint8Array(185));
  for (let y = 0; y < 400; y++) {
    const row = rows[y];
    for (let x = 0; x < 184; x++) {
      const value = picture.pixels[y * 320 + 70 + x]; // JP.C: rowbuf + 70
      row[x] = value === 0 ? 64 : value;
    }
    row[184] = 65;
  }
  buildBounceTables();
  atRest = new Uint8Array(320 * 400);
  const save = jplogoVram;
  for (let y = 0; y < 400; y++) linezoom(y * 320, rows[y], 184);
  atRest.set(save);
  console.log('[JPLOGO] exact _PIC.OBK + JP.C jelly tables loaded');
}

function showScrolledStart(startRow) {
  jplogoVram.fill(0);
  const visible = 400 - startRow;
  if (visible > 0)
    jplogoVram.set(atRest.subarray(startRow * 320, 400 * 320), 0);
}

function paintJelly(frame) {
  // JP.C retains the final table values after frame 511.
  const tableFrame = Math.min(frame, 511);
  const y1 = trunc(framey1t[tableFrame] / 16);
  const y2 = trunc(framey2t[tableFrame] / 16);
  const xsc = trunc((400 - (y2 - y1)) / 8);
  for (let y = 0; y < 400; y++) {
    if (y < y1 || y >= y2) {
      linezoom(y * 320, null, 0);
    } else {
      const b = trunc(((y - y1) * 400) / (y2 - y1));
      let width = 184 + trunc((sin1024[trunc((b * 32) / 25)] * xsc + 32) / 64);
      width &= ~1;
      linezoom(y * 320, rows[b], width);
    }
  }
}

export function jplogoReset() {
  localFrame = 0;
  state = 'setup-wait-1';
  scrollY = 400 * 64;
  scrollA = 64;
  jellyFrame = 0;
  done = false;
  doneAtLocal = null;
  jplogoVram.fill(0);
}

export function jplogoEnded() { return done; }
export function jplogoLocalFrames() { return localFrame; }
export function jplogoMode400() { return true; }
export function jplogoDurationS() {
  return doneAtLocal ?? Math.max(0, localFrame) / VBLANK_HZ;
}

export function jplogoStepTo(seconds, replay, musplusAtLocal) {
  if (done) return false;
  const target = Math.floor(seconds * VBLANK_HZ);
  let steps = target - localFrame;
  if (steps <= 0) return true;
  if (steps > 35 && !replay) steps = 35;
  for (let s = 0; s < steps && !done; s++) {
    localFrame++;
    if (state === 'setup-wait-1') { state = 'setup-wait-2'; continue; }
    if (state === 'setup-wait-2') {
      showScrolledStart(400);
      state = 'drop';
      continue;
    }
    if (state === 'drop') {
      scrollY -= scrollA;
      scrollA += 6;
      if (scrollY < 0) scrollY = 0;
      showScrolledStart(trunc(scrollY / 64));
      if (scrollY === 0) state = 'post-drop-wait';
      continue;
    }
    if (state === 'post-drop-wait') { state = 'music-wait'; continue; }
    if (state === 'music-wait') {
      const musplus = musplusAtLocal ? musplusAtLocal(localFrame / VBLANK_HZ) : 4;
      if (musplus < 4) continue;
      state = 'jelly';
    }
    jellyFrame++;
    paintJelly(jellyFrame);
    if (jellyFrame >= 700) {
      done = true;
      doneAtLocal = localFrame / VBLANK_HZ;
    }
  }
  return !done;
}
