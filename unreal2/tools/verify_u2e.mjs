#!/usr/bin/env node
// Structural + deterministic runtime verification for the U2E scene port.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..');

globalThis.fetch = async asset => {
  const data = await readFile(join(web, asset));
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(data),
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  };
};

const geo = JSON.parse(await readFile(join(web, 'assets/u2e_geo.json'), 'utf8'));
const anim = await readFile(join(web, 'assets/u2e_anim.bin'));
assert.equal(geo.instanceCount, 58);
assert.equal(geo.instances.length, 58);
assert.equal(Object.keys(geo.models).length, 42);
assert.equal(geo.animation.frames, 1801);
assert.equal(geo.animation.actions, 4047);
assert.equal(geo.animation.maxObject, 57);
assert.deepEqual(geo.animation.fovs, [0x1c00]);
assert.equal(anim.length, 77069);

let vertices = 0, normals = 0, polygons = 0, lists = 0;
for (const model of Object.values(geo.models)) {
  vertices += model.vertices.length;
  normals += model.normals.length;
  polygons += model.polygons.length;
  lists += model.lists.length;
  assert.equal(model.lists.length, 9);
  for (const list of model.lists) {
    assert.ok(list.sort >= 0 && list.sort < model.vertices.length);
    for (const polygon of list.polygons) assert.ok(polygon >= 0 && polygon < model.polygons.length);
  }
  for (const polygon of model.polygons) {
    assert.ok(polygon.normal >= 0 && polygon.normal < model.normals.length);
    assert.ok(polygon.vertices.length >= 3 && polygon.vertices.length <= 16);
    for (const vertex of polygon.vertices) assert.ok(vertex >= 0 && vertex < model.vertices.length);
  }
}
assert.deepEqual({ vertices, normals, polygons, lists },
  { vertices: 1796, normals: 1211, polygons: 987, lists: 378 });

const u2e = await import(`../u2e.js?verify=${Date.now()}`);
await u2e.loadU2e();

// JPLOGO handoff: 400 unique address rows are inherited. fadeset writes only
// the upper 200 before the first wait; max-scanline switches to double-scan
// after that wait, not at the moment the aperture bytes are written.
const jelly = new Uint8Array(320 * 400);
for (let y = 0; y < 400; y++) jelly.fill(y & 0xff, y * 320, (y + 1) * 320);
const jellyPal = new Uint8Array(768).fill(23);
u2e.u2eReset(jelly, jellyPal);
assert.equal(u2e.u2eVram[100 * 320], 100);
assert.equal(u2e.u2eVram400[300 * 320], 300 & 0xff);
u2e.u2eStepTo(49 / 70, true, null, () => 18);
assert.equal(u2e.u2eMode400(), true);
assert.equal(u2e.u2eVram400[300 * 320], 300 & 0xff);
assert.equal(u2e.u2eVram400[1 * 320 + 300], 1, 'top-right JP pixels survive fadeset');
assert.equal(u2e.u2eVram400[1 * 320 + 80], 252, 'top aperture center');
assert.equal(u2e.u2eVram400[10 * 320 + 80], 252, 'later rows overwrite the +252 spill');
assert.equal(u2e.u2eVram400[25 * 320 + 80], 253, 'middle aperture overwrites spill');
u2e.u2eStepTo(50 / 70, true, null, () => 18);
assert.equal(u2e.u2eMode400(), false);

// The original has no order-gate timeout.
u2e.u2eReset();
u2e.u2eStepTo(10, true, null, () => 18);
assert.equal(u2e.u2eSourceState().phase, 'wait-order');
assert.equal(u2e.u2eSourceState().animationFrames, 0);
u2e.u2eStepTo(10.1, true, null, () => 19);
assert.equal(u2e.u2eSourceState().phase, 'vectors');
assert.ok(u2e.u2eSourceState().animationFrames > 0);

// Deterministic authored checkpoint: 1001/1801 animation frames decoded.
u2e.u2eReset();
u2e.u2eStepTo(30, true, null, () => 19);
assert.deepEqual(u2e.u2eSourceState(), {
  phase: 'vectors', localFrame: 2100, animationFrames: 1001,
  streamOffset: 41571, streamBytes: 77069,
});
const checkpoint = createHash('sha256').update(u2e.u2eVram).update(u2e.u2ePal).digest('hex');
assert.equal(checkpoint, '1ab9c7cba9578ac7a24eb73ed7f97b3c1809f62dd578c71ea9337ebad77f921c');

// End marker is consumed exactly, followed by U2E.C's 16-vblank DAC fade.
u2e.u2eStepTo(60, true, null, () => 19);
assert.equal(u2e.u2eEnded(), true);
assert.equal(u2e.u2eSourceState().animationFrames, 1801);
assert.equal(u2e.u2eSourceState().streamOffset, anim.length);
assert.equal(u2e.u2eDurationS(), 3718 / 70);
const immediateDuration = u2e.u2eDurationS();

// Full-loader timing: STARTMUS patches MUSIC0 tempo 0x7d -> 0x78, then
// U2.ASM enters the otherwise hidden order-18 sequence. This regression
// catches both an order-zero timeline and a seconds seek to the wrong song.
const { descramble, buildTimeline, rowAtTime } = await import('../s3msim.js');
const music0 = await readFile(join(web, 'assets/music0.s3m'));
const music0Buffer = music0.buffer.slice(music0.byteOffset, music0.byteOffset + music0.byteLength);
new Uint8Array(music0Buffer)[50] = 0x78;
const u2eMusic = buildTimeline(descramble(music0Buffer), { startOrder: 18, maxOrders: 128 });
u2e.u2eReset();
u2e.u2eStepTo(100, true, null,
  localSeconds => rowAtTime(u2eMusic, localSeconds)?.orderIdx ?? 18);
assert.equal(u2e.u2eEnded(), true);
assert.equal(u2e.u2eDurationS(), 3898 / 70);
const loaderDuration = u2e.u2eDurationS();

console.log(JSON.stringify({
  scene: { instances: 58, models: 42, vertices, normals, polygons, lists },
  animation: geo.animation,
  checkpoint,
  durationSecondsWithImmediateOrderGate: immediateDuration,
  durationSecondsFromLoaderOrder18: loaderDuration,
}, null, 2));
