// Render stills of the demo's own artwork into img/art/ for the site.
//
//   node tools/make_site_art.mjs
//
// Everything here comes out of assets/ that the port already decodes, so it is
// all Future Crew's own public-domain art (Unlicense) — no external images, no
// screenshots of someone else's capture. Pure Node: PNG is written with a
// minimal encoder over the built-in zlib, so there are no dependencies.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readOmfSegments } from './extract_post_minv_assets.mjs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..');
const OUT = join(WEB, '..', 'img', 'art');
const ROOT = join(WEB, '..');
mkdirSync(OUT, { recursive: true });

// ---- minimal PNG writer ----------------------------------------------------

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
// rgb: Uint8Array(w*h*3)
function writePng(path, w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                       // filter: none
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;  // 8-bit RGB
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

// ---- helpers ---------------------------------------------------------------

const rd = (...p) => new Uint8Array(readFileSync(join(WEB, ...p)));

// 6-bit VGA DAC -> 8-bit, and optional integer upscale
function paint(name, w, h, pal6, pixels, { scale = 2, srcW = w } = {}) {
  const W = w * scale, H = h * scale;
  const rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const sy = (y / scale) | 0;
    for (let x = 0; x < W; x++) {
      const sx = (x / scale) | 0;
      const c = pixels[sy * srcW + sx];
      const o = (y * W + x) * 3;
      rgb[o] = Math.min(255, pal6[c * 3] * 255 / 63);
      rgb[o + 1] = Math.min(255, pal6[c * 3 + 1] * 255 / 63);
      rgb[o + 2] = Math.min(255, pal6[c * 3 + 2] * 255 / 63);
    }
  }
  const path = join(OUT, `${name}.png`);
  writePng(path, W, H, rgb);
  console.log(`  ${name}.png  ${W}x${H}`);
}

// ---- the art ---------------------------------------------------------------

console.log('rendering Future Crew artwork from the port\'s own assets:');

// TECHNO's endcard troll (PANICPIC.LBM) — 320x400, the demo's most iconic still
{
  const raw = rd('assets', 'panicpic.bin');
  paint('troll', 320, 400, raw.subarray(16, 16 + 768), raw.subarray(784), { scale: 2 });
}

// BEG: the SECOND REALITY title painting (SRTITLE.UP, 320x400)
{
  const d = rd('assets', 'srtitle.up');
  const u16 = o => d[o] | (d[o + 1] << 8);
  const wid = u16(2), hig = u16(4), cols = u16(6), add = u16(8);
  const pal = d.subarray(16, 16 + cols * 3);
  const pix = new Uint8Array(wid * hig);
  let p = add * 16;
  for (let y = 0; y < hig; y++) {
    const bytes = u16(p); p += 2;
    const end = p + bytes;
    let u = y * wid;
    while (p < end) {
      const a = d[p++];
      if (a >= 0x80) { const n = (a & 0x7f) || 256; pix.fill(d[p++], u, u + n); u += n; }
      else pix[u++] = a;
    }
    p = end;
  }
  paint('title', wid, hig, pal, pix, { scale: 2 });
}

// ALKU's HOI panorama (640x200 wide starfield/mountains) — the intro backdrop
{
  const hz = rd('assets', 'hzpic.bin');
  paint('panorama', 640, 200, hz.subarray(16, 16 + 768), hz.subarray(784), { scale: 2 });
}

// MNTSCRL's moonlit forest (HILLBACK, extracted from the OMF object)
{
  const hb = rd('assets', 'hillback.bin');
  paint('forest', 320, 200, hb.subarray(0, 768), hb.subarray(768), { scale: 2 });
}

// A couple of the CRED paintings, from the SHIPPED CRED.EXE (160x100, and the
// palette is shifted up 16 entries with pixels offset to match — see cred.js)
for (const [name, file] of [['cred-ship', 'pic02'], ['cred-city', 'pic16']]) {
  const b = rd('assets', 'cred', `${file}.bin`);
  const w = b[0] | (b[1] << 8), h = b[2] | (b[3] << 8);
  const src = b.subarray(4, 4 + 768);
  const pal = new Uint8Array(src);
  pal.set(src.subarray(0, 768 - 16 * 3), 16 * 3);
  for (let i = 0; i < 10; i++) pal.fill(7 * i, i * 3, i * 3 + 3);
  const pix = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) pix[i] = (b[772 + i] + 16) & 0xff;
  paint(name, w, h, pal, pix, { scale: 3 });
}

// The dev tree's placeholder for credits screen 2, straight out of
// CREDITS/INCLUDE.OBJ. The shipped CRED.EXE has finished art in this slot (see
// cred-ship.png); this is what the development build still carried.
{
  const segs = await readOmfSegments(join(ROOT, 'CREDITS', 'INCLUDE.OBJ'));
  const b = segs.get(2);
  if (b) {
    // linked 'UH' layout: 0xfcfc magic, u16 width, u16 height, palette at 16,
    // pixels at 784 (see normalizeCredPicture in extract_post_minv_assets.mjs)
    const w = b[2] | (b[3] << 8), h = b[4] | (b[5] << 8);
    const src = b.subarray(16, 784);
    const pal = new Uint8Array(src);
    pal.set(src.subarray(0, 768 - 16 * 3), 16 * 3);
    for (let i = 0; i < 10; i++) pal.fill(7 * i, i * 3, i * 3 + 3);
    const pix = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) pix[i] = (b[784 + i] + 16) & 0xff;
    paint('cred-placeholder', w, h, pal, pix, { scale: 3 });
  } else console.log('  (no segment 2 in CREDITS/INCLUDE.OBJ — skipped)');
}

console.log(`\nwrote to img/art/ — all Unlicense (Future Crew, 1993/2013)`);
