#!/usr/bin/env node
// Convert the original VISU scene files used by U2E.C to browser assets.
//
// The formats are documented by VISU/C/DOC and implemented by
// VISU/VISU.C + VISU/C/SAVE.C.  This intentionally keeps the precomputed
// ORD0/ORDE polygon lists: vis_drawobject() selects one of those lists from
// the transformed sort vertices, so flattening them would change the city.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const source = join(repo, 'MAIN/DATA');
const assets = join(repo, 'unreal2/assets');

function fail(message) { throw new Error(message); }
function ascii(data, start, length) {
  return data.subarray(start, start + length).toString('latin1');
}
function cstring(data) {
  const end = data.indexOf(0);
  return data.subarray(0, end < 0 ? data.length : end).toString('latin1');
}

function parseObject(data, modelId) {
  let at = 0;
  let rawName = '';
  let vertices = null;
  let normals = null;
  let basicNormals = 0;
  let polyData = null;
  const lists = [];

  while (at + 8 <= data.length) {
    const tag = ascii(data, at, 4);
    const length = data.readUInt32LE(at + 4);
    const first = at + 8;
    const end = first + length;
    if (end > data.length) fail(`U2E.${String(modelId).padStart(3, '0')}: ${tag} block overruns file`);
    const body = data.subarray(first, end);

    if (tag === 'END ') break;
    if (tag === 'VERS') {
      if (body.readUInt16LE(0) !== 0x100) fail(`model ${modelId}: unsupported VERS`);
    } else if (tag === 'NAME') {
      rawName = cstring(body);
    } else if (tag === 'VERT') {
      const count = body.readUInt16LE(0);
      if (4 + count * 16 > body.length) fail(`model ${modelId}: truncated VERT`);
      vertices = new Array(count);
      for (let i = 0, p = 4; i < count; i++, p += 16) {
        vertices[i] = [body.readInt32LE(p), body.readInt32LE(p + 4),
          body.readInt32LE(p + 8), body.readInt16LE(p + 12)];
      }
    } else if (tag === 'NORM') {
      const count = body.readUInt16LE(0);
      basicNormals = body.readUInt16LE(2);
      if (4 + count * 8 > body.length) fail(`model ${modelId}: truncated NORM`);
      normals = new Array(count);
      for (let i = 0, p = 4; i < count; i++, p += 8) {
        normals[i] = [body.readInt16LE(p), body.readInt16LE(p + 2), body.readInt16LE(p + 4)];
      }
    } else if (tag === 'POLY') {
      polyData = body;
    } else if (tag === 'ORD0' || tag === 'ORDE') {
      const words = body.readUInt16LE(0);
      if (words * 2 > body.length || words < 3) fail(`model ${modelId}: malformed ${tag}`);
      const offsets = [];
      for (let p = 4; p < words * 2; p += 2) {
        const offset = body.readUInt16LE(p);
        if (offset === 0) break;
        offsets.push(offset);
      }
      lists.push({ sort: body.readUInt16LE(2), offsets });
    }
    at = end;
  }

  if (!vertices || !normals || !polyData || lists.length === 0) fail(`model ${modelId}: incomplete object`);
  const offsets = [...new Set(lists.flatMap(list => list.offsets))];
  const offsetToIndex = new Map();
  const polygons = offsets.map((offset, index) => {
    if (offset + 6 > polyData.length) fail(`model ${modelId}: polygon ${offset} outside POLY`);
    const sides = polyData.readUInt8(offset);
    if (sides < 3 || sides > 16 || offset + 6 + sides * 2 > polyData.length) {
      fail(`model ${modelId}: malformed polygon ${offset}`);
    }
    const vertexIndices = new Array(sides);
    for (let i = 0; i < sides; i++) vertexIndices[i] = polyData.readUInt16LE(offset + 6 + i * 2);
    offsetToIndex.set(offset, index);
    return {
      flags: polyData.readUInt8(offset + 1) << 8,
      color: polyData.readInt16LE(offset + 2),
      normal: polyData.readUInt16LE(offset + 4),
      vertices: vertexIndices,
    };
  });
  for (const list of lists) list.polygons = list.offsets.map(offset => offsetToIndex.get(offset));
  for (const list of lists) delete list.offsets;

  return {
    // Keep the quotes written by READASC/SAVE.C. U2E.C deliberately tests
    // name[1..3], i.e. characters just inside the opening quote.
    name: rawName,
    vertices,
    normals,
    basicNormals,
    polygons,
    lists,
  };
}

function validateAnimation(anim, instanceCount) {
  let at = 0;
  let frames = 0;
  let actions = 0;
  let maxObject = 0;
  const fovs = new Set();
  const get = () => {
    if (at >= anim.length) fail('U2E.0AB: animation read past end');
    return anim[at++];
  };
  const skipSigned = size => { at += size === 1 ? 1 : size === 2 ? 2 : size === 3 ? 4 : 0; };

  animation: for (;;) {
    let object = 0;
    for (;;) {
      let command = get();
      if (command === 0xff) {
        command = get();
        if (command <= 0x7f) {
          frames++;
          fovs.add(command << 8);
          break;
        }
        if (command === 0xff) break animation;
      }
      if ((command & 0xc0) === 0xc0) {
        object = (command & 0x3f) << 4;
        command = get();
      }
      object = (object & 0xff0) | (command & 0x0f);
      maxObject = Math.max(maxObject, object);
      if (object >= instanceCount) fail(`U2E.0AB: object ${object} >= ${instanceCount}`);
      actions++;
      let flags = 0;
      const flagBytes = (command >> 4) & 3;
      for (let i = 0; i < flagBytes; i++) flags |= get() << (i * 8);
      skipSigned(flags & 3);
      skipSigned((flags >> 2) & 3);
      skipSigned((flags >> 4) & 3);
      const matrixSize = (flags & 0x40) ? 2 : 1;
      for (let i = 0; i < 9; i++) if (flags & (0x80 << i)) at += matrixSize;
      if (at > anim.length) fail('U2E.0AB: truncated action payload');
    }
  }
  if (at !== anim.length) fail(`U2E.0AB: ${anim.length - at} trailing bytes`);
  return { bytes: anim.length, frames, actions, maxObject, fovs: [...fovs] };
}

async function main() {
  const material = await readFile(join(source, 'U2E.00M'));
  if (ascii(material, 0, 2) !== 'FC') fail('U2E.00M: bad signature');
  const objectTable = material.readUInt32LE(4);
  if (objectTable < 16 + 768 || objectTable + 2 > material.length) fail('U2E.00M: bad object table');
  const palette = [...material.subarray(16, 16 + 768)];
  const instanceCount = material.readUInt16LE(objectTable);
  const instances = [0];
  for (let i = 1; i < instanceCount; i++) instances.push(material.readUInt16LE(objectTable + i * 2));
  if (objectTable + instanceCount * 2 !== material.length) fail('U2E.00M: unexpected trailing data');

  const sequence = await readFile(join(source, 'U2E.0AA'));
  if (sequence.length !== 8 || sequence.readInt16LE(0) !== 1 || sequence.readInt16LE(4) !== -1) {
    fail('U2E.0AA: expected the shipped single-scene 0AB sequence');
  }
  const anim = await readFile(join(source, 'U2E.0AB'));
  const animation = validateAnimation(anim, instanceCount);

  const modelIds = [...new Set(instances.slice(1))].sort((a, b) => a - b);
  const models = {};
  for (const id of modelIds) {
    const file = join(source, `U2E.${String(id).padStart(3, '0')}`);
    models[id] = parseObject(await readFile(file), id);
  }

  const geo = {
    source: 'MAIN/DATA/U2E.*',
    instanceCount,
    instances,
    palette,
    models,
    animation,
  };
  await writeFile(join(assets, 'u2e_geo.json'), `${JSON.stringify(geo)}\n`);
  await writeFile(join(assets, 'u2e_anim.bin'), anim);
  console.log(JSON.stringify({ instanceCount, models: modelIds.length, ...animation }, null, 2));
}

await main();
