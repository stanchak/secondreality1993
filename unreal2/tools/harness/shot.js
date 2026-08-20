#!/usr/bin/env node
/**
 * shot.js - headless-browser screenshot + console capture harness
 *
 * Usage: node shot.js <url> <settleMs> <outPng> <outLog>
 *
 * Loads <url>, lets it run for <settleMs> milliseconds to boot/render,
 * takes a full-page screenshot at 1280x960, and writes a verbatim log of
 * console messages, page errors, and failed network requests to <outLog>.
 *
 * WebGL note: tries default chromium launch args first. If a WebGL context
 * failure is detected in console output, relaunches with
 * ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] and retries the
 * whole capture once. Whichever launch mode succeeds (or is used last) is
 * recorded at the top of the log file.
 */

const { chromium } = require('playwright');
const fs = require('fs');

const [, , url, settleMsArg, outPng, outLog] = process.argv;

if (!url || !settleMsArg || !outPng || !outLog) {
  console.error('Usage: node shot.js <url> <settleMs> <outPng> <outLog>');
  process.exit(2);
}

const settleMs = parseInt(settleMsArg, 10);

const WEBGL_FAILURE_PATTERNS = [
  /webgl.*context.*(lost|fail|creat)/i,
  /failed to create.*webgl/i,
  /getcontext.*(webgl|null)/i,
  /no webgl/i,
];

async function attemptCapture(launchArgs, label) {
  const logLines = [];
  const log = (line) => logLines.push(line);

  const browser = await chromium.launch({
    headless: true,
    args: launchArgs,
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 960 },
    });
    const page = await context.newPage();

    page.on('console', (msg) => {
      const loc = msg.location();
      const locStr = loc && loc.url ? ` (${loc.url}:${loc.lineNumber})` : '';
      log(`[console.${msg.type()}] ${msg.text()}${locStr}`);
    });

    page.on('pageerror', (err) => {
      log(`[pageerror] ${err && err.stack ? err.stack : err}`);
    });

    page.on('requestfailed', (req) => {
      const failure = req.failure();
      log(`[requestfailed] ${req.method()} ${req.url()} - ${failure ? failure.errorText : 'unknown error'}`);
    });

    page.on('response', (res) => {
      if (res.status() >= 400) {
        log(`[http-error] ${res.status()} ${res.request().method()} ${res.url()}`);
      }
    });

    page.on('crash', () => {
      log('[pagecrash] page crashed');
    });

    let navError = null;
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    } catch (e) {
      navError = e;
      log(`[navigation-error] ${e && e.stack ? e.stack : e}`);
    }

    await page.waitForTimeout(settleMs);

    let screenshotError = null;
    try {
      await page.screenshot({ path: outPng });
    } catch (e) {
      screenshotError = e;
      log(`[screenshot-error] ${e && e.stack ? e.stack : e}`);
    }

    const hasWebglFailure = logLines.some((line) =>
      WEBGL_FAILURE_PATTERNS.some((re) => re.test(line))
    );

    await context.close();
    return { logLines, hasWebglFailure, navError, screenshotError, label };
  } finally {
    await browser.close();
  }
}

(async () => {
  const defaultArgs = [];
  const swiftshaderArgs = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

  let result = await attemptCapture(defaultArgs, 'default chromium launch args');

  if (result.hasWebglFailure) {
    const firstAttemptLines = result.logLines.slice();
    const retry = await attemptCapture(swiftshaderArgs, 'swiftshader fallback (--use-angle=swiftshader --enable-unsafe-swiftshader)');
    result = retry;
    result.logLines.unshift(
      `[harness] WebGL context failure detected on default launch args; retried with SwiftShader fallback.`,
      `[harness] --- original (default args) console output below, for reference ---`,
      ...firstAttemptLines.map((l) => `[harness/first-attempt] ${l}`),
      `[harness] --- end original console output; SwiftShader retry output follows ---`
    );
  }

  const header = [
    `[harness] url=${url}`,
    `[harness] settleMs=${settleMs}`,
    `[harness] launch-mode-used=${result.label}`,
    `[harness] timestamp=${new Date().toISOString()}`,
    '',
  ];

  fs.writeFileSync(outLog, header.concat(result.logLines).join('\n') + '\n');

  if (result.navError || result.screenshotError) {
    console.error(`shot.js: completed with errors (see ${outLog})`);
    process.exit(1);
  }
  console.log(`shot.js: wrote ${outPng} and ${outLog} (launch mode: ${result.label})`);
})().catch((err) => {
  console.error('shot.js: fatal error', err);
  process.exit(1);
});
