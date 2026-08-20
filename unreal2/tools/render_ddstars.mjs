// Render frames of the hidden part headlessly, so its geometry can be checked
// against the source rather than eyeballed in a browser.
//
//   node tools/render_ddstars.mjs 1200 1560 3600 [outdir]
//
// Writes <outdir>/ddstars_<frame>.png at 320x400 through the part's own palette,
// and prints per-frame coverage — the number that says whether the ring buffers
// are saturating.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, '..', 'assets');

const args = process.argv.slice(2);
const outDir = args.find(a => a.includes('/')) || '/tmp';
const frames = args.filter(a => /^\d+$/.test(a)).map(Number);
if (!frames.length) frames.push(1, 60, 300, 900, 1210, 1500, 1560, 2000, 3600, 3700);

// The module fetches its asset; give it a fetch that reads from disk.
const textBin = await readFile(path.join(ASSETS, 'ddstars_text.bin'));
globalThis.fetch = async (url) => {
  if (!String(url).endsWith('ddstars_text.bin')) throw new Error(`unexpected fetch ${url}`);
  return { arrayBuffer: async () => textBin.buffer.slice(textBin.byteOffset, textBin.byteOffset + textBin.byteLength) };
};

const m = await import('../ddstars.js');
await m.loadDdstars();
m.ddstarsReset();

const W = m.DDSTARS_W, H = m.DDSTARS_H;

function png(idx, pal6) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  let o = 0;
  for (let y = 0; y < H; y++) {
    raw[o++] = 0;
    for (let x = 0; x < W; x++) {
      const c = idx[y * W + x];
      raw[o++] = Math.min(255, Math.round(pal6[c * 3] * 255 / 63));
      raw[o++] = Math.min(255, Math.round(pal6[c * 3 + 1] * 255 / 63));
      raw[o++] = Math.min(255, Math.round(pal6[c * 3 + 2] * 255 / 63));
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) : crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
let T = null;
function crc32(buf) {
  if (!T) { T = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c; } }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

await mkdir(outDir, { recursive: true });
const want = new Set(frames);
const maxFrame = Math.max(...frames);
console.log(`frame   lit%   colours present            palette c1/c3`);
for (let f = 1; f <= maxFrame; f++) {
  m.ddstarsStepTo(f / 70, true);
  if (!want.has(f)) continue;
  const idx = m.ddstarsVram;
  const hist = new Array(16).fill(0);
  for (let i = 0; i < idx.length; i++) hist[idx[i]]++;
  const lit = ((idx.length - hist[0]) / idx.length * 100).toFixed(1);
  const present = hist.map((n, c) => n ? `${c}:${n}` : null).filter(Boolean).join(' ');
  const p = m.ddstarsPal;
  console.log(`${String(f).padStart(5)} ${lit.padStart(6)}   ${present.padEnd(38)} ` +
              `${p[3]},${p[4]},${p[5]} / ${p[9]},${p[10]},${p[11]}`);
  await writeFile(path.join(outDir, `ddstars_${f}.png`), png(idx, p));
}
console.log(`\nwrote ${frames.length} frames to ${outDir}`);
