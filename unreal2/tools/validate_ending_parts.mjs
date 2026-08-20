#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, '..');
const root = path.resolve(web, '..');
const hash = bytes => crypto.createHash('sha1').update(bytes).digest('hex');

globalThis.fetch = async input => {
  const relative = String(input).replace(/^https?:\/\/[^/]+\//, '');
  const bytes = await readFile(path.join(web, relative));
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    json: async () => JSON.parse(bytes.toString('utf8')),
    text: async () => bytes.toString('utf8'),
  };
};

const importPart = name => import(`${pathToFileURL(path.join(web, `${name}.js`)).href}?verify=1`);
const [jp, end, cred, scroll] = await Promise.all([
  importPart('jplogo'), importPart('endlogo'), importPart('cred'), importPart('endscrl'),
]);

const jpPacked = await readFile(path.join(web, 'assets/jplogo.up'));
assert.equal(jpPacked.length, 58566);
assert.equal(hash(jpPacked), '7b4d112298149d998d6e25d31406102520e6d42d');
assert.deepEqual(
  await readFile(path.join(web, 'assets/endlogo.up')),
  await readFile(path.join(root, 'END/PIC.UH')),
);
assert.equal(hash(await readFile(path.join(web, 'assets/cred_fona.bin'))),
  '1d36fcce0d5a9510201d4c7a990af79b01ea8514');
assert.equal(hash(await readFile(path.join(web, 'assets/endscrl_fona.bin'))),
  '39ac76635f16abaf78dd47c19f101ad302b3ff57');
assert.deepEqual(
  await readFile(path.join(web, 'assets/endscrol.txt')),
  await readFile(path.join(root, 'MAIN/DATA/ENDSCROL.TXT')),
);

await jp.loadJplogo();
jp.jplogoReset();
let dropTicks = 0, dropY = 400 * 64, dropA = 64;
while (dropY > 0) { dropY -= dropA; dropA += 6; if (dropY < 0) dropY = 0; dropTicks++; }
const jpTicks = 2 + dropTicks + 1 + 700;
jp.jplogoStepTo(jpTicks / 70, true, () => 4);
assert.equal(jp.jplogoEnded(), true);
assert.equal(jp.jplogoDurationS(), jpTicks / 70);
assert.ok(jp.jplogoVram.some(value => value !== 0));

await end.loadEndlogo();
const inheritedEndPal = new Uint8Array(768);
inheritedEndPal.fill(63, 765);
end.endlogoReset(inheritedEndPal);
const endTicks = 2 + 32 + 129 + 1 + 64;
end.endlogoStepTo(endTicks / 70, true, () => 0);
assert.equal(end.endlogoEnded(), true);
assert.equal(end.endlogoDurationS(), endTicks / 70);
assert.ok(end.endlogoPal.subarray(0, 765).every(value => value === 0));
assert.ok(end.endlogoPal.subarray(765).every(value => value === 63));

await cred.loadCred();
cred.credReset();
let inTicks = 0;
for (let y = 200 * 128; y > 0; y = Math.trunc(y * 12 / 13)) inTicks++;
let outTicks = 0;
for (let y = 0, v = 0; y < 128 * 200; y += v, v += 15) outTicks++;
const credTicks = 21 * (1 + inTicks + 200 + outTicks);
cred.credStepTo(credTicks / 70, true);
assert.equal(cred.credEnded(), true);
assert.equal(cred.credDurationS(), credTicks / 70);
assert.equal(cred.credVram.length, 320 * 400);

await scroll.loadEndscrl();
scroll.endscrlReset();
scroll.endscrlStepTo(3, true);
assert.equal(scroll.endscrlVram.length, 640 * 400);
assert.equal(scroll.endscrlEnded(), false);
assert.equal(scroll.endscrlDurationS(), null);
assert.ok(scroll.endscrlVram.some(value => value !== 0));

// Shipped-build directives (see endscrl.js's header): `[nn` is a blank gap nn
// scanlines tall, `%` calls exit(0). MAIN/DATA/ENDSCROL.TXT has 163 of the
// former and exactly one of the latter, and its line heights are 25 by default.
// Walking the whole part must terminate, and must do so after the exact number
// of scanlines the text implies -- 2 vblanks per scanline.
{
  const raw = await readFile(path.join(web, 'assets/endscrol.txt'));
  const lines = [];
  for (let i = 0; i < raw.length;) {
    let j = raw.indexOf(10, i);
    if (j < 0) j = raw.length - 1;
    lines.push(raw.subarray(i, j + 1));
    i = j + 1;
  }
  let scanlines = 0, directives = 0, term = -1;
  for (let n = 0; n < lines.length; n++) {
    const L = lines[n];
    if (L[0] === 0x25) { term = n; break; }
    if (L[0] === 0x5b) { directives++; scanlines += (L[1] - 48) * 10 + L[2] - 48; }
    else scanlines += 25;
  }
  assert.equal(directives, 163, 'shipped ENDSCROL.TXT must carry 163 `[nn` directives');
  assert.ok(term > 0, 'shipped ENDSCROL.TXT must carry a `%` terminator');
  assert.equal(scanlines, 11500, 'total scanlines to the terminator');

  scroll.endscrlReset();
  const expectS = scanlines * 2 / 70;
  // step past the expected end and confirm it stops there, not before or after
  scroll.endscrlStepTo(expectS - 0.5, true);
  assert.equal(scroll.endscrlEnded(), false, 'must not end early');
  scroll.endscrlStepTo(expectS + 1.0, true);
  assert.equal(scroll.endscrlEnded(), true, 'must end at the `%` line');
  const d = scroll.endscrlDurationS();
  assert.ok(Math.abs(d - expectS) < 0.1, `duration ${d} vs expected ${expectS}`);
  console.log(`  ENDSCRL: ${directives} gaps, terminator at line ${term}, ` +
    `${scanlines} scanlines = ${d.toFixed(1)}s`);
}

console.log(`Ending validation passed: JP ${jpTicks}f, END ${endTicks}f, CRED ${credTicks}f, EGA terminated`);
