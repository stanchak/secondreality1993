#!/usr/bin/env node

// Deterministic source/port regression checks for unreal2/minvball.js.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const repoRoot = path.resolve(webRoot, '..');
const tablesPath = path.join(webRoot, 'assets', 'tables.json');
const tables = JSON.parse(fs.readFileSync(tablesPath, 'utf8'));

// Browser fetch shim used by loadMinvball().
globalThis.fetch = async url => {
  assert.equal(url, 'assets/tables.json');
  return { ok: true, status: 200, json: async () => tables };
};

const moduleUrl = `${pathToFileURL(path.join(webRoot, 'minvball.js')).href}?validation=1`;
const minv = await import(moduleUrl);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// DOTS/SIN1024.INC is the source of truth for the fetched JSON table.
const sinSource = fs.readFileSync(path.join(repoRoot, 'DOTS', 'SIN1024.INC'), 'utf8');
const sinWords = sinSource.split(/\r?\n/).slice(1).join('\n').match(/-?\d+/g).map(Number);
assert.equal(sinWords.length, 1024);
assert.deepEqual(tables.sin1024, sinWords);

// Confirm the checked-in object really is the newer ASM.ASM 3-row/32-bit
// draw path, not DOTS/A's older 2-row implementation.
const asmObject = fs.readFileSync(path.join(repoRoot, 'DOTS', 'ASM.OBJ'));
assert.notEqual(asmObject.indexOf(Buffer.from('c1ed0683e5fc', 'hex')), -1,
  'ASM.OBJ must contain shr bp,6 / and bp,not 3');
assert.notEqual(asmObject.indexOf(Buffer.from('66648b05', 'hex')), -1,
  'ASM.OBJ must contain 32-bit sprite background loads');

// The distributed part is a PKLITE wrapper around the same DOTS.EXE header.
const distributed = fs.readFileSync(path.join(repoRoot, 'MAIN', 'DATA', 'MINVBALL.EXE'));
const dotsExe = fs.readFileSync(path.join(repoRoot, 'DOTS', 'DOTS.EXE'));
assert.deepEqual(distributed.subarray(0x56, 0x74), dotsExe.subarray(2, 0x20));
assert.notEqual(dotsExe.indexOf(Buffer.from('b8fd43ba0300', 'hex')), -1,
  'Microsoft rand multiplier 000343fd must be present');
assert.notEqual(dotsExe.indexOf(Buffer.from('05c39e83d226', 'hex')), -1,
  'Microsoft rand increment 00269ec3 must be present');

await minv.loadMinvball();
minv.minvballReset();

assert.equal(minv.minvballVram.length, 64000);
assert.equal(minv.minvballLocalFrames(), 0);
assert.equal(minv.minvballDurationS(), 0);
assert.equal(minv.minvballEnded(), false);
assert.equal(minv.minvballVram[99 * 320], 0);
assert.equal(minv.minvballVram[100 * 320], 64);
assert.equal(minv.minvballVram[199 * 320 + 319], 163);
assert.ok(minv.minvballPal.every(value => value === 0));

// Two waits per palette step: wait 129 still has the penultimate level, wait
// 130 has installed pal[] exactly (MAIN.C:171-183).
minv.minvballStepTo(129 / 70, true, () => -32);
assert.equal(sha256(minv.minvballPal),
  'fe5b9e373f764d0d4a3196e97bfc8c88b5d443a2ef02074dceec1e8961af202b');
minv.minvballStepTo(130 / 70, true, () => -32);
assert.equal(sha256(minv.minvballPal),
  '8baadcdc247785dabd9ad409198a36e5395a507576e12526f5ba0d18b865ef23');
assert.deepEqual([...minv.minvballPal.subarray(164 * 3, 164 * 3 + 3)], [28, 28, 20]);
assert.deepEqual([...minv.minvballPal.subarray(247 * 3, 247 * 3 + 3)], [11, 12, 16]);
assert.ok(minv.minvballPal.subarray(248 * 3, 255 * 3).every(value => value === 0));
assert.deepEqual([...minv.minvballPal.subarray(255 * 3)], [31, 0, 15]);
assert.equal(minv.minvballLocalFrames(), 0);

// These hashes straddle every MAIN.C motion/palette branch and lock the C RNG,
// 16-bit arithmetic, draw order, old-position restoration, and palette lag.
const checkpoints = new Map([
  [1, 'e434b26055a9a7c439d9e7e023016506d0d28ddb7c34a52da03c30b12422e722'],
  [500, '36725534b147f25ae3c017cef9f1b4313d8e770db68b0ec6dd17e106703b97ae'],
  [900, 'bbaf3edb1d968a4f61f36cd326a1739f6128abfb5afd29ec07a109603abd4cdf'],
  [1700, '975f58a2db0fd9b656131863105adf95fb3a6cf103fc2c9e622df4f2f2e20d6f'],
  [1920, 'd65facd6c605f211162f6ffc606104118f808d1aba57e4655cfa82369c129f49'],
  [2361, 'a32b5c68f4c953ffa11f523a453b164e2ca80792080446081ed959172915aaa4'],
  [2399, '6fedd4751c68c15e93517f11e9d14bb069e4204dee94e12858c7fe848127e14f'],
  [2400, '51d03248e4b6a47da45d509abb6eae34b74841167f019d721823c852595055da'],
  [2439, '9de4b81768d2bf10097fb1d5aecc227d6d66db9022b77284bd5897c3a4b37e97'],
  [2450, '98554dea7e3b279d5886a276ce36ab5f7e985206ad2eebcfb7f623ba39762e90'],
]);
for (const [mainFrame, expected] of checkpoints) {
  minv.minvballStepTo((130 + mainFrame) / 70, true, () => -32);
  assert.equal(minv.minvballLocalFrames(), mainFrame);
  assert.equal(sha256(minv.minvballVram), expected, `raster at MAIN.C frame ${mainFrame}`);
}
assert.equal(minv.minvballEnded(), true);
assert.equal(minv.minvballDurationS(), 2580 / 70);
assert.ok(minv.minvballPal.every(value => value === 0));

// The music marker is checked after waitb but before frame physics.  A -3 at
// local tick 140 therefore exits with only nine main frames drawn.
minv.minvballReset();
minv.minvballStepTo(3, true, localS => localS >= 140 / 70 ? -3 : -32);
assert.equal(minv.minvballEnded(), true);
assert.equal(minv.minvballLocalFrames(), 9);
assert.equal(minv.minvballDurationS(), 2);

console.log('MINVBALL validation passed: source tables, object variant, fades, raster, RNG, timing, music exit');
