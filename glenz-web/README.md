# Second Reality — Glenz Vectors, browser port

A faithful browser port of the **glenz vectors part** of *Second Reality*
(Future Crew, Assembly '93), built entirely from the original source released
into the public domain for the demo's 20th anniversary. Every asset — image
data **and music** — comes from the files in this repository; nothing is
downloaded or substituted.

The music takes some work, because the `MUSIC*.S3M` files here have their
**pattern data XOR-scrambled** on disk — Future Crew's anti-ripping
protection. The descrambler lived inside their private STMIK player build
(`MAIN/2NDFIX.EXE` was the tool FC later shipped so rippers could unscramble
extracted files). Played raw, the file is literally random notes on real
instruments. `assets/music1.s3m` is therefore a **verbatim copy** of
`MAIN/MUSIC1.S3M` (still scrambled), and `main.js` descrambles it in the
browser at load time — exactly as the demo's own player did — using a
keystream recovered from the scrambled files alone (see
`tools/recover_keystream.py`). The recovered descramble reproduces the
officially released clean song's pattern data byte-for-byte, confirming the
key is exact. The order list is not scrambled; it carries the `+++` markers
the demo uses to sync parts to the music (see below).

## Run

```sh
./serve.sh          # serves on http://localhost:8093
```

Then open <http://localhost:8093> and click. (A web server is required —
the music player uses an AudioWorklet, which browsers refuse on `file://`.)

## What you're seeing

The port replicates the original program (`GLENZ/MAIN.C` + assembly) rather
than imitating the effect:

- **Virtual VGA** — a 320×200 (mode 13h) indexed framebuffer with a 6-bit
  256-entry palette, presented through a Three.js palette-lookup shader.
  The intro (title screen + wipe) runs in the previous part's 320×400 mode.
- **The renderer** is the original's "transparent new copper": polygon edges
  become per-scanline XOR color transitions; consecutive frames are diffed and
  only changed spans are written. Glenz transparency = each visible face gets a
  dynamically allocated 16-entry palette block of `face brightness + background/4`.
- **Physics** — the jello drop/squash of the ball is live integer physics
  (not precalc), reproduced with the same integer truncation semantics.
  The splat against the pedestal is the original view-space Y clamp.
- **Music** — "UnreaL ][" by Purple Motion played with libopenmpt, started
  exactly where the original sequencer (`U2.EXE`) starts it for this part
  (module 1, order 0), with the part's timeline driven by a virtual 70 Hz
  vblank clock anchored to the audio clock — the same master-clock
  relationship the demo used via its DIS interrupt server.
- **Sync** — the demo's S3M order list contains `+++` (254) markers at
  section boundaries; DIS exposes a row countdown to the next marker
  (`dis_musplus`). The part waits for `musplus >= -19` (19 rows before the
  first marker = 6.519 s into the song) to start the wipe, and exits when
  the countdown to the second marker reaches 15 rows (~43.7 s), where the
  dot tunnel takes over in the demo. Both gates are reproduced as absolute
  music-clock times computed with libopenmpt.

## Debug switches (URL params)

- `?silent` — no audio, no click gate, timeline on a performance clock
- `?silent&jump=N` — start the virtual clock at N seconds (screenshot harness)
- `?log` — log phase transitions

## Layout

- `main.js` — the entire port (pipeline, span engine, timeline, display,
  music load + in-browser S3M descramble)
- `assets/` — data extracted from the original release (music, images, sine
  tables). `music1.s3m` is a verbatim copy of `MAIN/MUSIC1.S3M`, still
  scrambled; it is descrambled at load time.
- `vendor/` — three.js and chiptune3/libopenmpt (see their licenses)
- `tools/` — extraction & screenshot tooling, plus `recover_keystream.py`,
  which reconstructs the music-protection XOR keystream from the scrambled
  files alone (no clean reference needed)

Timing of the visual milestones (wipe at 6.52 s, ball drop at 11.28 s — on
the section change at order 4 — part end at ~43.7 s) matches the original's
music-synchronized gates.
