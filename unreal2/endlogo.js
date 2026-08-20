// ENDLOGO — exact port of END/END.C + READP.C + ASM.ASM.
// The source performs 34 setup vblanks, a 129-step white-to-picture fade,
// a dis_musplus()>-16 hold (capped at 5000 waits), and a 64-step fade to black.

const VBLANK_HZ = 70;
const trunc = Math.trunc;

export const endlogoVram = new Uint8Array(320 * 400);
export const endlogoPal = new Uint8Array(768);

let pixels = null;
let picturePal = null;
let localFrame = 0;
let state = 'first-wait';
let setupWaits = 0;
let fadeFrame = 0;
let holdFrame = 0;
let done = false;
let doneAtLocal = null;

function decodePackedPicture(d) {
  const u16 = o => d[o] | (d[o + 1] << 8);
  const width = u16(2), height = u16(4), colors = u16(6), dataOffset = u16(8) * 16;
  if (width !== 320 || height !== 400 || colors !== 256)
    throw new Error(`ENDLOGO packed-picture header ${width}x${height}/${colors}`);
  const palette = d.slice(16, 16 + colors * 3);
  const out = new Uint8Array(width * height);
  let p = dataOffset;
  for (let y = 0; y < height; y++) {
    const bytes = u16(p); p += 2;
    const end = p + bytes;
    let dest = y * width;
    while (p < end) {
      const tag = d[p++];
      if (tag & 0x80) {
        const count = (tag & 0x7f) || 256, value = d[p++];   // 0x80 = run of 256
        out.fill(value, dest, dest + count);
        dest += count;
      } else out[dest++] = tag;
    }
    if (p !== end || dest !== (y + 1) * width)
      throw new Error(`ENDLOGO corrupt packed row ${y}`);
  }
  return { palette, pixels: out };
}

export async function loadEndlogo() {
  const packed = new Uint8Array(await fetch('assets/endlogo.up').then(r => r.arrayBuffer()));
  ({ palette: picturePal, pixels } = decodePackedPicture(packed));
  console.log('[ENDLOGO] exact END/_PIC.OBK packed picture loaded');
}

function setWhite() {
  endlogoPal.fill(63, 0, 765); // END.C deliberately leaves DAC entry 255 alone
}

export function endlogoReset(previousPal) {
  localFrame = 0;
  state = 'first-wait';
  setupWaits = 0;
  fadeFrame = 0;
  holdFrame = 0;
  done = false;
  doneAtLocal = null;
  endlogoVram.fill(0);
  endlogoPal.fill(0);
  // END.C writes DAC entries 0..254 only; entry 255 is inherited from U2E.
  if (previousPal?.length === 768) endlogoPal.set(previousPal.subarray(765), 765);
}

export function endlogoEnded() { return done; }
export function endlogoLocalFrames() { return localFrame; }
export function endlogoMode400() { return true; }
export function endlogoDurationS() {
  return doneAtLocal ?? Math.max(0, localFrame) / VBLANK_HZ;
}

export function endlogoStepTo(seconds, replay, musplusAtLocal) {
  if (done) return false;
  const target = Math.floor(seconds * VBLANK_HZ);
  let steps = target - localFrame;
  if (steps <= 0) return true;
  if (steps > 35 && !replay) steps = 35;
  for (let s = 0; s < steps && !done; s++) {
    localFrame++;
    if (state === 'first-wait') {
      setWhite();
      state = 'second-wait';
      continue;
    }
    if (state === 'second-wait') {
      setWhite();
      state = 'setup-waits';
      continue;
    }
    if (state === 'setup-waits') {
      setupWaits++;
      if (setupWaits >= 32) {
        endlogoVram.set(pixels);
        fadeFrame = 0;
        state = 'fade-in';
      }
      continue;
    }
    if (state === 'fade-in') {
      // END.C: for(c=0;c<=128;c++), entries 0..254 only.
      for (let i = 0; i < 765; i++)
        endlogoPal[i] = trunc(((128 - fadeFrame) * 63 + picturePal[i] * fadeFrame) / 128);
      fadeFrame++;
      if (fadeFrame > 128) { state = 'hold'; holdFrame = 0; }
      continue;
    }
    if (state === 'hold') {
      holdFrame++;
      const musplus = musplusAtLocal ? musplusAtLocal(localFrame / VBLANK_HZ) : 0;
      if (musplus > -16 || holdFrame >= 5000) {
        state = 'fade-out';
        fadeFrame = 63;
      }
      continue;
    }
    // END.C: for(c=63;c>=0;c--), again only entries 0..254.
    for (let i = 0; i < 765; i++) endlogoPal[i] = trunc((picturePal[i] * fadeFrame) / 64);
    fadeFrame--;
    if (fadeFrame < 0) {
      done = true;
      doneAtLocal = localFrame / VBLANK_HZ;
    }
  }
  return !done;
}
