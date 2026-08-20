// Pull candidate photographs into the site and write a manifest you can check.
//
//   node tools/fetch_people_photos.mjs <list.json> [--force]
//
// The list is [{subject, image_url, page_url, note}] — the shape the research
// step produces. Everything lands in img/people/candidates/ and NOTHING is
// referenced by a page until it is moved out of there deliberately, so a
// candidate cannot reach the published site by accident.
//
// It writes img/people/MANIFEST.md: one row per file with its subject, the
// page it came from, the direct URL and a licence column. The licence column is
// filled in only where the source states it unambiguously (Wikimedia file pages
// and Flickr both do); everything else is left as UNVERIFIED rather than guessed,
// because a photograph of a living person on a public page is exactly the kind of
// thing that should not be published on an assumption.
//
// Approving one is two steps:
//   1. move it up:  mv img/people/candidates/foo.jpg img/people/
//   2. reference it from the crew page, with the credit line the manifest gives

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(ROOT, 'img', 'people', 'candidates');

const listPath = process.argv[2];
const force = process.argv.includes('--force');
if (!listPath) {
  console.error('usage: node tools/fetch_people_photos.mjs <list.json> [--force]');
  process.exit(2);
}

// The research output may be wrapped; find the array wherever it sits.
const raw = JSON.parse(await readFile(listPath, 'utf8'));
const items = Array.isArray(raw) ? raw
  : raw.images ?? raw.result?.images ?? raw.data?.images ?? [];
if (!items.length) { console.error('no images in the list'); process.exit(1); }

await mkdir(OUT, { recursive: true });

const slug = s => String(s).toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'image';

// Licence is only asserted where the host states it plainly.
function licenceFrom(pageUrl, note) {
  const n = (note || '').toLowerCase();
  for (const [re, label] of [
    [/\bcc0\b|public domain dedication/, 'CC0'],
    [/\bpublic domain\b|\bpd-/, 'public domain'],
    [/cc[ -]?by[ -]?sa[ -]?([0-9.]+)?/, 'CC BY-SA'],
    [/cc[ -]?by[ -]?nc/, 'CC BY-NC (non-commercial only)'],
    [/cc[ -]?by\b/, 'CC BY'],
    [/gfdl/, 'GFDL'],
    [/all rights reserved/, 'ALL RIGHTS RESERVED — do not publish'],
  ]) if (re.test(n)) return label;
  if (/commons\.wikimedia\.org/.test(pageUrl)) return 'UNVERIFIED (check the Commons file page)';
  if (/flickr\.com/.test(pageUrl)) return 'UNVERIFIED (check the Flickr licence line)';
  return 'UNVERIFIED';
}

const rows = [];
let ok = 0, failed = 0, skipped = 0;

for (const [i, it] of items.entries()) {
  const url = it.image_url;
  if (!url || !/^https?:\/\//.test(url)) { failed++; continue; }
  const ext = (url.match(/\.(jpe?g|png|webp|gif)(?:\?|$)/i)?.[1] || 'jpg').toLowerCase();
  const name = `${String(i + 1).padStart(2, '0')}-${slug(it.subject)}.${ext.replace('jpeg', 'jpg')}`;
  const dest = path.join(OUT, name);

  if (existsSync(dest) && !force) {
    skipped++;
  } else {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'SecondReality-port/1.0 (site build; contact via GitHub stanchak/secondreality1993)' },
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get('content-type') || '';
      if (!type.startsWith('image/')) throw new Error(`not an image (${type || 'no type'})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) throw new Error(`suspiciously small (${buf.length}B)`);
      await writeFile(dest, buf);
      ok++;
      console.log(`  ok    ${name}  ${(buf.length / 1024).toFixed(0)}K`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${name}  ${e.message}`);
      rows.push({ name: `(not fetched) ${name}`, ...it, licence: licenceFrom(it.page_url, it.note), error: e.message });
      continue;
    }
  }
  rows.push({ name, ...it, licence: licenceFrom(it.page_url, it.note) });
}

const md = [
  '# Candidate photographs',
  '',
  'Downloaded by `unreal2/tools/fetch_people_photos.mjs`. Everything here is in',
  '`candidates/` and is **not referenced by any page** — move a file up into',
  '`img/people/` and reference it from the crew screens to publish it.',
  '',
  'The licence column is filled in only where the source states it plainly.',
  '**UNVERIFIED means exactly that** — open the source page and check before',
  'publishing a photograph of a person.',
  '',
  '| file | subject | licence | source page | direct url |',
  '|---|---|---|---|---|',
  ...rows.map(r => `| ${r.name} | ${r.subject || '?'} | ${r.licence} | ${r.page_url || '?'} | ${r.image_url} |`),
  '',
  `_${ok} fetched, ${skipped} already present, ${failed} failed — ${rows.length} rows._`,
  '',
].join('\n');

await writeFile(path.join(ROOT, 'img', 'people', 'MANIFEST.md'), md);

console.log(`\n${ok} fetched, ${skipped} already present, ${failed} failed`);
console.log(`manifest: img/people/MANIFEST.md`);
const unver = rows.filter(r => r.licence.startsWith('UNVERIFIED')).length;
const banned = rows.filter(r => r.licence.startsWith('ALL RIGHTS')).length;
if (unver) console.log(`${unver} row(s) need a licence check before publishing`);
if (banned) console.log(`${banned} row(s) are marked all-rights-reserved`);
