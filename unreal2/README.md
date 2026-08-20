# unreal2 — the port

The whole demo as one page. `main.js` owns the clock, the display and the phase
machine, and also carries the two parts that open the demo (ALKU, the title
cards and panorama; BEGLOGO, the title). Every other part is its own module,
ported from that part's source directory in the 1993 release. The
[top-level README](../README.md) explains how it works; this is the operator's
card.

## Run

```sh
python3 tools/serve.py 8094     # no-cache dev server; serves whatever directory you run it from
```

A web server is required — the music plays through an AudioWorklet, which
browsers refuse on `file://`. Run it from the repository root and the same
server gives you the board at `/` and this player at `/unreal2/`.

## URL parameters

| | |
|---|---|
| `?part=<slug>` | start at a part: `cards` `panorama` `ship` `moon` `logo` `glenz` `tunnel` `techno` `panic` `mntscrl` `lens` `plasma` `minvball` `rayscrl` `sinfield` `jellypic` `u2e` `endlogo` `credits` `endscrl` — or `hidden` |
| `?jump=<s>` | start the timeline at `<s>` seconds of demo time |
| `?silent` | no audio, no click gate, the timeline on a performance clock — what the screenshot harness uses |
| `?phaselog` | log phase transitions to the console |
| `?credlog` | trace ALKU's credit loop |

## Layout

```
main.js        host: framebuffer, palette shader, transport, phase machine, music load + descramble, ALKU and BEGLOGO
<part>.js      one module per part, in chain order: u2a pam glenz tunnel techno panic mntscrl lnszoom plzpart
               minvball rayscrl sinfield jplogo u2e endlogo cred endscrl — and ddstars, the hidden one
s3msim.js      the S3M descrambler, and the offline timeline simulator the music gates are derived from
assets/        83 files, every one regenerated from the release by a tool in tools/
tools/         extract_*.mjs and convert_u2e.mjs rebuild assets/; validate_*.mjs and verify_u2e.mjs are the
               validators; av_skew.mjs plays real audio; shot.sh + harness/ take screenshots;
               make_site_art.mjs renders the site's gallery; serve.py is the dev server
vendor/        libopenmpt (BSD-2-Clause) and chiptune3 (MIT)
```

## Validators

```sh
for f in tools/validate_*.mjs tools/verify_u2e.mjs; do node "$f" || break; done
```

All nine are deterministic and silent, and need nothing but Node: each points
`fetch()` at the filesystem and imports the same module the browser runs. The
tenth, `node tools/av_skew.mjs`, needs the dev server up and plays audio; it is
the only check that can see audio/visual drift.

## Screenshots

```sh
(cd tools/harness && npm install && npx playwright install chromium)
tools/shot.sh <seconds> out.png     # 1280x960 capture of ?silent&jump=<seconds>, console log beside it
```
