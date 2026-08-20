// CRED — exact port of CREDITS/MAIN.C + TWEAK.ASM.
// This emulates the 4-plane 64 KiB VGA aperture, CRTC start/pixel-pan, the
// line-compare split, the original FONA strip, and the two integer animations.

const VBLANK_HZ = 70;
const PLANE_BYTES = 65536;
const FONT_H = 32;
const FONT_STRIDE = 1500;
const FONT_ORDER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/?!:,."()+-';

export const credVram = new Uint8Array(320 * 400);
export const credPal = new Uint8Array(768);

const SCREEN_DEFS = [
  ['pic01', ['GRAPHICS - MARVEL', 'MUSIC - SKAVEN', 'CODE - WILDFIRE']],
  ['pic02', ['GRAPHICS - MARVEL', 'MUSIC - SKAVEN', 'CODE - PSI']],
  ['pic03', ['GRAPHICS - MARVEL', 'MUSIC - SKAVEN', 'CODE - WILDFIRE', 'ANIMATION - TRUG']],
  ['pic04', ['', 'GRAPHICS - PIXEL']],
  ['pic05', ['GRAPHICS - PIXEL', 'MUSIC - PURPLE MOTION', 'CODE - PSI']],
  ['pic05b', ['', 'MUSIC - PURPLE MOTION', 'CODE - TRUG']],
  ['pic06', ['', 'MUSIC - PURPLE MOTION', 'CODE - PSI']],
  ['pic07', ['', 'MUSIC - PURPLE MOTION', 'CODE - PSI']],
  ['pic08', ['', 'GRAPHICS - PIXEL', 'MUSIC - PURPLE MOTION']],
  ['pic09', ['GRAPHICS - PIXEL', 'MUSIC - PURPLE MOTION', 'CODE - TRUG', 'RENDERING - TRUG']],
  ['pic10', ['GRAPHICS - PIXEL, SKAVEN', 'MUSIC - PURPLE MOTION', 'CODE - PSI']],
  ['pic10b', ['GRAPHICS - PIXEL, SKAVEN', 'MUSIC - PURPLE MOTION', 'CODE - PSI']],
  ['pic11', ['', 'MUSIC - PURPLE MOTION', 'CODE - WILDFIRE']],
  ['pic12', ['', 'MUSIC - PURPLE MOTION', 'CODE - WILDFIRE']],
  ['pic13', ['', 'MUSIC - PURPLE MOTION', 'CODE - PSI']],
  ['pic14', ['GRAPHICS - PIXEL', 'MUSIC - PURPLE MOTION', 'CODE - TRUG', 'RENDERING - TRUG']],
  ['pic14b', ['', 'MUSIC - PURPLE MOTION', 'CODE - PSI']],
  ['pic15', ['GRAPHICS - MARVEL', 'MUSIC - PURPLE MOTION', 'CODE - PSI']],
  ['pic16', ['', 'MUSIC - SKAVEN', 'CODE - PSI']],
  ['pic17', ['', 'GRAPHICS - PIXEL', 'MUSIC - PURPLE MOTION']],
  ['pic18', ['GRAPHICS - PIXEL', 'MUSIC - PURPLE MOTION', 'CODE - WILDFIRE']],
];

let screens = null;
let font = null;
const fontPos = new Int32Array(256);
const fontWidth = new Int32Array(256);
const planes = new Uint8Array(4 * PLANE_BYTES);
let localFrame = 0;
let screenIndex = 0;
let state = 'screen-setup';
let inY = 0;
let holdFrame = 0;
let outY = 0;
let outV = 0;
let crtcStart = 160 * 200;
let split = 400;
let pixelShift = 0;
let done = false;
let doneAtLocal = null;

function buildFontMetrics() {
  fontPos.fill(0);
  fontWidth.fill(0);
  let x = 0;
  for (const ch of FONT_ORDER) {
    while (x < FONT_STRIDE) {
      let y = 0;
      while (y < FONT_H && font[y * FONT_STRIDE + x] === 0) y++;
      if (y !== FONT_H) break;
      x++;
    }
    const start = x;
    while (x < FONT_STRIDE) {
      let y = 0;
      while (y < FONT_H && font[y * FONT_STRIDE + x] === 0) y++;
      if (y === FONT_H) break;
      x++;
    }
    fontPos[ch.charCodeAt(0)] = start;
    fontWidth[ch.charCodeAt(0)] = x - start;
  }
  fontPos[32] = FONT_STRIDE - 32;
  fontWidth[32] = 8;
}

function shiftedPalette(source) {
  const pal = source.slice();
  // MAIN.C's overlapping memmove: palette entries 16..255 receive original
  // entries 0..239, while entries 10..15 keep their original values.
  pal.set(source.subarray(0, 768 - 16 * 3), 16 * 3);
  for (let i = 0; i < 10; i++) pal.fill(7 * i, i * 3, i * 3 + 3);
  return pal;
}

export async function loadCred() {
  const [fontBytes, ...pictureBytes] = await Promise.all([
    fetch('assets/cred_fona.bin').then(r => r.arrayBuffer()),
    ...SCREEN_DEFS.map(([name]) => fetch(`assets/cred/${name}.bin`).then(r => r.arrayBuffer())),
  ]);
  font = new Uint8Array(fontBytes);
  if (font.length !== FONT_H * FONT_STRIDE) throw new Error('CRED FONA size');
  buildFontMetrics();
  screens = pictureBytes.map((buffer, i) => {
    const bytes = new Uint8Array(buffer);
    const width = bytes[0] | (bytes[1] << 8);
    const height = bytes[2] | (bytes[3] << 8);
    if (width !== 160 || height !== 100) throw new Error(`CRED picture ${i + 1} size`);
    const originalPal = bytes.slice(4, 4 + 768);
    return {
      palette: shiftedPalette(originalPal),
      pixels: bytes.slice(4 + 768, 4 + 768 + width * height),
      lines: SCREEN_DEFS[i][1],
    };
  });
  console.log('[CRED] exact 21-screen VGA/FONA sequence loaded');
}

function planeAt(plane, offset) { return plane * PLANE_BYTES + (offset & 0xffff); }

function putPixel(x, y, color) {
  const plane = x & 3;
  const offset = ((x >> 2) + 80 * y) & 0xffff; // TWEAK.ASM tw_putpixel
  planes[planeAt(plane, offset)] = color & 0xff;
}

function clearScreenWorkArea() {
  // tw_clrscr writes 0x4000 bytes through map mask 0x0f, not all 64 KiB.
  for (let p = 0; p < 4; p++) planes.fill(0, p * PLANE_BYTES, p * PLANE_BYTES + 0x4000);
}

function textWidth(text) {
  let width = 0;
  for (let i = 0; i < text.length; i++) width += fontWidth[text.charCodeAt(i)] + 2;
  return width;
}

function printCentered(y, text) {
  let x = 160 - Math.trunc(textWidth(text) / 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const source = fontPos[code];
    const width = fontWidth[code];
    for (let gx = 0; gx < width; gx++)
      for (let gy = 0; gy < FONT_H; gy++)
        putPixel(x + gx, y + gy, font[gy * FONT_STRIDE + source + gx]);
    x += width + 2;
  }
}

function setupScreen() {
  const screen = screens[screenIndex];
  split = 400;
  clearScreenWorkArea();
  crtcStart = 160 * 200;
  pixelShift = 0;
  credPal.set(screen.palette);
  let y = 16;
  for (const line of screen.lines) { printCentered(y, line); y += FONT_H + 10; }
  for (let py = 0; py < 100; py++)
    for (let px = 0; px < 160; px++)
      putPixel(400 + px, 400 + py * 2, (screen.pixels[py * 160 + px] + 16) & 0xff);
  inY = 200 * 128;
  state = 'in';
}

function readCrtcPixel(address, x) {
  const plane = x & 3;
  const offset = (address + (x >> 2)) & 0xffff;
  return planes[planeAt(plane, offset)];
}

function renderCrtc() {
  // Register 9 = 1: each address row is double-scanned. Attribute mode bit 5
  // resets pixel pan below line compare, exactly separating text and picture.
  for (let y = 0; y < 400; y++) {
    const below = y > split;
    const relativeY = below ? y - split - 1 : y;
    const address = (below ? 0 : crtcStart) + Math.trunc(relativeY / 2) * 160;
    const shift = below ? 0 : pixelShift;
    const dest = y * 320;
    for (let x = 0; x < 320; x++) credVram[dest + x] = readCrtcPixel(address, x + shift);
  }
}

export function credReset() {
  localFrame = 0;
  screenIndex = 0;
  state = 'screen-setup';
  done = false;
  doneAtLocal = null;
  planes.fill(0); // tw_opengraph clears the complete VGA aperture
  credVram.fill(0);
  credPal.fill(0);
}

export function credEnded() { return done; }
export function credLocalFrames() { return localFrame; }
export function credDurationS() {
  return doneAtLocal ?? Math.max(0, localFrame) / VBLANK_HZ;
}

export function credStepTo(seconds, replay) {
  if (done) return false;
  const target = Math.floor(seconds * VBLANK_HZ);
  let steps = target - localFrame;
  if (steps <= 0) return true;
  if (steps > 35 && !replay) steps = 35;
  for (let s = 0; s < steps && !done; s++) {
    localFrame++;
    if (state === 'screen-setup') { setupScreen(); continue; }
    if (state === 'in') {
      split = Math.trunc(inY / 128) + 200;
      const yy = 320 - Math.trunc(inY / 80);
      crtcStart = 160 * 200 + Math.trunc(yy / 4);
      pixelShift = yy & 3;
      inY = Math.trunc((inY * 12) / 13);
      if (inY <= 0) { state = 'hold'; holdFrame = 0; }
      continue;
    }
    if (state === 'hold') {
      holdFrame++;
      if (holdFrame >= 200) { state = 'out'; outY = 0; outV = 0; }
      continue;
    }
    if (state === 'out') {
      split = Math.trunc(outY / 128) + 200;
      const yy = 320 + Math.trunc(outY / 80);
      crtcStart = 160 * 200 + Math.trunc(yy / 4);
      pixelShift = yy & 3;
      outY += outV;
      outV += 15;
      if (outY >= 128 * 200) {
        screenIndex++;
        if (screenIndex >= screens.length) {
          done = true;
          doneAtLocal = localFrame / VBLANK_HZ;
        } else state = 'screen-setup';
      }
    }
  }
  // The final output iteration mutates the CRTC before the executable exits;
  // present that last hardware state as well.
  renderCrtc();
  return !done;
}
