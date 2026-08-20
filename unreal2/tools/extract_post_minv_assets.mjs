#!/usr/bin/env node
// Deterministically extract browser-ready data from the exact objects/includes
// linked by the original JPLOGO, CRED and ENDSCRL executables.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const assets = path.join(root, 'unreal2/assets');

function omfIndex(bytes, cursor) {
  const first = bytes[cursor++];
  return (first & 0x80)
    ? { value: ((first & 0x7f) << 8) | bytes[cursor++], cursor }
    : { value: first, cursor };
}

// DOOBJ stored the packed picture as a single OMF segment split across 1 KiB
// LEDATA records.  Honor each record's segment offset; concatenating record
// payloads also concatenates OMF metadata and corrupts JPLOGO after row two.
export async function readOmfSegments(input) {
  const obj = new Uint8Array(await readFile(input));
  let cursor = 0;
  const segments = new Map();
  while (cursor < obj.length) {
    if (cursor + 3 > obj.length) throw new Error(`truncated OMF record in ${input}`);
    const type = obj[cursor];
    const length = obj[cursor + 1] | (obj[cursor + 2] << 8);
    const bodyStart = cursor + 3;
    const bodyEnd = bodyStart + length - 1; // final byte is the OMF checksum
    if (bodyEnd >= obj.length) throw new Error(`bad OMF record length in ${input}`);
    // Borland's generated data objects use a zero checksum byte to mean
    // "checksum omitted". Validate every record that actually carries one.
    let checksum = 0;
    for (let p = cursor; p <= bodyEnd; p++) checksum = (checksum + obj[p]) & 0xff;
    if (obj[bodyEnd] !== 0 && checksum !== 0)
      throw new Error(`bad OMF checksum at ${cursor} in ${input}`);
    if (type === 0xa0) { // 16-bit LEDATA
      let p = bodyStart;
      const seg = omfIndex(obj, p); p = seg.cursor;
      const offset = obj[p] | (obj[p + 1] << 8); p += 2;
      const data = obj.slice(p, bodyEnd);
      let record = segments.get(seg.value);
      if (!record) {
        record = { chunks: [], size: 0 };
        segments.set(seg.value, record);
      }
      record.chunks.push({ offset, data });
      record.size = Math.max(record.size, offset + data.length);
    }
    cursor = bodyStart + length;
  }
  if (cursor !== obj.length || segments.size === 0) throw new Error(`invalid OMF ${input}`);
  const output = new Map();
  for (const [number, record] of segments) {
    const bytes = new Uint8Array(record.size);
    for (const { offset, data } of record.chunks) bytes.set(data, offset);
    output.set(number, bytes);
  }
  return output;
}

async function extractOmfLeData(input, output, segment = 1) {
  const segments = await readOmfSegments(input);
  const out = segments.get(segment);
  if (!out) throw new Error(`missing OMF segment ${segment} in ${input}`);
  await writeFile(output, out);
  return out.length;
}

function normalizeCredPicture(source, name) {
  if (source.length !== 16784 || source[0] !== 0xfc || source[1] !== 0xfc ||
      source[2] !== 160 || source[3] !== 0 || source[4] !== 100 || source[5] !== 0)
    throw new Error(`${name}: unexpected linked UH picture`);
  const out = new Uint8Array(4 + 768 + 160 * 100);
  out.set(source.subarray(2, 6), 0);       // width + height
  out.set(source.subarray(16, 784), 4);   // VGA palette
  out.set(source.subarray(784), 772);     // pixels
  return out;
}

// The dev tree's CREDITS/*.OBJ are a STALE build: 7 of the 21 picture payloads
// linked into the shipped MAIN/DATA/CRED.EXE are DIFFERENT ARTWORK (the OBJs
// still hold placeholders, including screen 2's "PART PIC MISSING (PXL SUX)"
// scrawl). Those 7 are owned by tools/extract_cred_shipped.mjs and must NOT be
// regenerated from here — see that file's header for the full derivation.
const CRED_SHIPPED_ONLY = new Set(
  ['pic02', 'pic05b', 'pic09', 'pic14b', 'pic16', 'pic17', 'pic18']);

async function extractCredPictures() {
  const groups = [
    ['CREDITS/INCLUDE.OBJ',
      ['pic01', 'pic02', 'pic03', 'pic04', 'pic05', 'pic05b',
       'pic06', 'pic07', 'pic08', 'pic09', 'pic10', 'pic10b']],
    ['CREDITS/INCLUD2.OBJ',
      ['pic11', 'pic12', 'pic13', 'pic14', 'pic14b', 'pic15',
       'pic16', 'pic17', 'pic18']],
  ];
  const results = [];
  for (const [relative, names] of groups) {
    const segments = await readOmfSegments(path.join(root, relative));
    for (let i = 0; i < names.length; i++) {
      const bytes = normalizeCredPicture(segments.get(i + 1), names[i]);
      if (CRED_SHIPPED_ONLY.has(names[i])) {
        results.push([`cred/${names[i]}.bin`, bytes.length, 'SKIPPED — owned by extract_cred_shipped.mjs']);
        continue;
      }
      await writeFile(path.join(assets, 'cred', `${names[i]}.bin`), bytes);
      results.push([`cred/${names[i]}.bin`, bytes.length]);
    }
  }
  return results;
}

async function extractDbInclude(input, output, expectedBytes) {
  const source = await readFile(input, 'utf8');
  const values = [...source.matchAll(/-?\d+/g)].map(m => Number(m[0]));
  if (values.length < expectedBytes)
    throw new Error(`${input}: expected ${expectedBytes} bytes, got ${values.length}`);
  const out = Uint8Array.from(values.slice(0, expectedBytes), n => n & 0xff);
  await writeFile(output, out);
  return out.length;
}

const written = [];
written.push(['jplogo.up', await extractOmfLeData(
  path.join(root, 'JPLOGO/_PIC.OBK'), path.join(assets, 'jplogo.up'))]);
written.push(['endlogo.up', await extractOmfLeData(
  path.join(root, 'END/_PIC.OBK'), path.join(assets, 'endlogo.up'))]);
written.push(['cred_fona.bin', await extractDbInclude(
  path.join(root, 'CREDITS/FONA.INC'), path.join(assets, 'cred_fona.bin'), 32 * 1500)]);
written.push(['endscrl_fona.bin', await extractDbInclude(
  path.join(root, 'ENDSCRL/FONA.INC'), path.join(assets, 'endscrl_fona.bin'), 30 * 1500)]);
written.push(...await extractCredPictures());
const endText = await readFile(path.join(root, 'MAIN/DATA/ENDSCROL.TXT'));
await writeFile(path.join(assets, 'endscrol.txt'), endText);
written.push(['endscrol.txt', endText.length]);

for (const [name, bytes] of written) console.log(`${name}: ${bytes} bytes`);
