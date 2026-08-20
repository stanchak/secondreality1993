// Measure the port's audio/visual skew with REAL audio playing.
//
//   node tools/av_skew.mjs [seconds]        (default 25; needs the dev server up)
//
// The demo's visual clock is `musicTime()` = AudioContext.currentTime - musicStart.
// The audio's true position is libopenmpt's own counter, reported out of the
// worklet and exposed as chip.getCurrentTime(). Because later parts restart the
// module, that counter is relative to the active module, so the comparison needs
// activeModuleOriginMt (the demo time at module position zero):
//
//     skew = musicTime() - (activeModuleOriginMt + chipPosition)
//
// skew > 0 means the visuals are running AHEAD of the music. main.js exposes all
// three via window.__av().
//
// Why this exists: when a part looks off the beat, A/V drift has to be ruled
// out before a frame-gate explanation (like glenz.js's mframe rate) can be
// trusted. Worth re-running after ANY change to
// startMusic/switchModule/the onProgress drift corrector, since nothing else in
// the test suite can see this class of bug — every validator is silent-mode and
// therefore has no audio clock at all.
//
// Note that the drift corrector deliberately slaves musicStart to the reported
// position, so a healthy reading is ~0 BY DESIGN; what this catches is the
// corrector failing to engage (suppressed, gated out, or fed a stale position),
// which is exactly what a module switch can cause.

import { chromium } from './harness/node_modules/playwright/index.mjs';

const RUN_MS = Number(process.argv[2] || 25) * 1000;
const URL = 'http://localhost:8094/';

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
page.on('pageerror', e => console.log('PAGEERROR', e.message));

await page.goto(URL, { waitUntil: 'load' });
// boot() arms the overlay only once every asset has loaded; clicking earlier
// does nothing, and startMusic() is what creates the audio context.
await page.waitForFunction(
  () => document.getElementById('overlay')?.classList.contains('ready'), { timeout: 180000 });
await page.click('#overlay');
await page.waitForFunction(() => window.__av && window.__av().pos > 0, { timeout: 30000 });

await page.evaluate(() => {
  window.__s = [];
  window.__iv = setInterval(() => {
    const a = window.__av();
    if (a.pos != null) window.__s.push(a);
  }, 250);
});
await page.waitForTimeout(RUN_MS);
const samples = await page.evaluate(() => { clearInterval(window.__iv); return window.__s; });
await browser.close();

console.log('    mt      pos   origin     skew  mod  phase');
let n = 0;
for (const a of samples) {
  if (n++ % 4) continue;                       // one line per second
  const skew = a.mt - (a.origin + a.pos);
  console.log(`${a.mt.toFixed(2).padStart(7)} ${a.pos.toFixed(2).padStart(8)} ` +
    `${a.origin.toFixed(2).padStart(8)} ${skew.toFixed(3).padStart(8)}   ${a.mod}  ${a.phase}`);
}
const sk = samples.filter(a => a.pos > 1).map(a => a.mt - (a.origin + a.pos));
if (!sk.length) { console.log('\nno usable samples'); process.exitCode = 1; }
else {
  const mean = sk.reduce((x, y) => x + y, 0) / sk.length;
  const worst = Math.max(...sk.map(Math.abs));
  console.log(`\nskew over ${sk.length} samples: mean ${mean.toFixed(3)}s  ` +
    `min ${Math.min(...sk).toFixed(3)}  max ${Math.max(...sk).toFixed(3)}`);
  // the drift corrector's own deadband is 0.08s, so anything past ~0.12 means it
  // is not doing its job rather than merely tolerating slack
  if (worst > 0.12) { console.log(`FAIL  |skew| reached ${worst.toFixed(3)}s (deadband is 0.08)`); process.exitCode = 1; }
  else console.log('PASS  visuals track the audio within the corrector deadband');
}
