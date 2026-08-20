# Glenz-Web Asset Extraction Report

How the three extracted assets under `glenz-web/assets/` were produced from the
1993 release at the repository root (public domain / Unlicense), and how each was
checked.

---

## STEP 1 — Vendor downloads

All four files downloaded via `curl` from jsdelivr, verified as real JS/binary
(not HTML error pages) by inspecting first bytes and comparing sizes against
expectations.

| File | Size (bytes) | Expected | SHA-256 |
|---|---|---|---|
| vendor/three.module.min.js | 670681 | ~450-700KB | `3e690ac7d180b0aadf0891bea39eec643e29e2d3e75c99b18689518665f69ba6` |
| vendor/chiptune3.js | 4152 | 4152 | `22f8e77423fa00a190edfc1057c11e24804baac9f3c174a90c3800f8107f2158` |
| vendor/chiptune3.worklet.js | 12358 | 12358 | `3b34510807975d9e9205aa4e2fa1ce51f37af3cf5f4326e42af8ee71b343d1fa` |
| vendor/libopenmpt.worklet.js | 1525909 | 1525909 | `31e39ff57d48bcc8c1fd9c04df16b1f8ec682cadb99d7c2f5bd682ca34e90554` |

All exact-size expectations matched precisely. `three.module.min.js` starts with
the three.js license banner comment and minified JS; `chiptune3.js` and
`chiptune3.worklet.js` are plain JS source; `libopenmpt.worklet.js` is a large
base64/wasm-embedding JS blob (reported by `file` as "data" due to its very long
lines, but confirmed to be JS text starting with `function atob(...)`).

No anomalies.

### Full contents of vendor/chiptune3.js

```js
/*
	chiptune3 (worklet version)
	based on: https://deskjet.github.io/chiptune2.js/
*/

const defaultCfg = {
	repeatCount: -1,		// -1 = play endless, 0 = play once, do not repeat
	stereoSeparation: 100,	// percents
	interpolationFilter: 0,	// https://lib.openmpt.org/doc/group__openmpt__module__render__param.html
	context: false,
}

export class ChiptuneJsPlayer {
	constructor(cfg) {
		this.config = {...defaultCfg, ...cfg}

		if (this.config.context) {
			if (!this.config.context.destination) {
				//console.error('This is not an audio context.')
				throw('ChiptuneJsPlayer: This is not an audio context')
			}
			this.context = this.config.context
			this.destination = false
		} else {
			this.context = new AudioContext()
			this.destination = this.context.destination	// output to speakers
		}
		delete this.config.context	// remove from config, just used here and after init not changeable

		// make gainNode
		this.gain = this.context.createGain()
		this.gain.gain.value = 1

		this.handlers = []

		// worklet
		this.context.audioWorklet.addModule( new URL('./chiptune3.worklet.js', import.meta.url) )
		.then(()=>{
			this.processNode = new AudioWorkletNode(this.context, 'libopenmpt-processor', {
				numberOfInputs: 0,
				numberOfOutputs: 1,
				outputChannelCount: [2]
			})
			// message port
			this.processNode.port.onmessage = this.handleMessage_.bind(this)
			this.processNode.port.postMessage({cmd:'config', val:this.config})
			this.fireEvent('onInitialized')

			// audio routing
			this.processNode.connect(this.gain)
			if (this.destination) this.gain.connect(this.destination)	// also connect to output if no gainNode was given
		})
		.catch(e=>console.error(e))
	}

	// msg from worklet
	handleMessage_(msg) {
		switch (msg.data.cmd) {
			case 'meta':
				this.meta = msg.data.meta
				this.duration = msg.data.meta.dur
				this.fireEvent('onMetadata', this.meta)
				break
			case 'pos':
				//this.meta.pos = msg.data.pos
				this.currentTime = msg.data.pos
				this.order = msg.data.order
				this.pattern = msg.data.pattern
				this.row = msg.data.row
				this.fireEvent('onProgress', msg.data)
				break
			case 'end':
				this.fireEvent('onEnded')
				break
			case 'err':
				this.fireEvent('onError', {type: msg.data.val})
				break
			case 'fullAudioData':
				this.fireEvent('onFullAudioData', msg.data)
				break
			default:
				console.log('Received unknown message',msg.data)
		}
	}

	// handlers
	fireEvent(eventName, response) {
		const handlers = this.handlers
		if (handlers.length) {
			handlers.forEach(function (handler) {
				if (handler.eventName === eventName) {
					handler.handler(response)
				}
			})
		}
	}
	addHandler(eventName, handler) { this.handlers.push({eventName: eventName, handler: handler}) }
	onInitialized(handler) { this.addHandler('onInitialized', handler) }
	onEnded(handler) { this.addHandler('onEnded', handler) }
	onError(handler) { this.addHandler('onError', handler) }
	onMetadata(handler) { this.addHandler('onMetadata', handler) }
	onProgress(handler) { this.addHandler('onProgress', handler) }
	onFullAudioData(handler) { this.addHandler('onFullAudioData', handler) }

	// methods
	postMsg(cmd, val) {
		if (this.processNode)
			this.processNode.port.postMessage({cmd:cmd,val:val})
	}
	load(url) {
		fetch(url)
		.then(response => response.arrayBuffer())
		.then(arrayBuffer => this.play(arrayBuffer))
		.catch(e=>{this.fireEvent('onError', {type: 'Load'})})
	}
	play(val) { this.postMsg('play', val) }
	stop() { this.postMsg('stop') }
	pause() { this.postMsg('pause') }
	unpause() { this.postMsg('unpause') }
	togglePause() { this.postMsg('togglePause') }
	setRepeatCount(val) { this.postMsg('repeatCount', val) }
	setPitch(val) { this.postMsg('setPitch', val) }
	setTempo(val) { this.postMsg('setTempo', val) }
	setPos(val) { this.postMsg('setPos', val) }
	setOrderRow(o,r) { this.postMsg('setOrderRow', {o:o,r:r}) }
	setVol(val) { this.gain.gain.value = val }
	selectSubsong(val) { this.postMsg('selectSubsong', val) }
	// compatibility
	seek(val) { this.setPos(val) }
	getCurrentTime() { return this.currentTime }
	decodeAll(ab) { this.postMsg('decodeAll', ab) }
}
```

**API summary**: `new ChiptuneJsPlayer(cfg)` creates an AudioContext + gain node
and asynchronously loads `chiptune3.worklet.js` as an AudioWorklet module
(resolved relative to `chiptune3.js` via `import.meta.url` — so both files must
sit next to each other, which they do in `vendor/`). Key methods: `.load(url)`
(fetches + plays a module file), `.play(arrayBuffer)`, `.stop()`, `.pause()`,
`.unpause()`, `.togglePause()`, `.setRepeatCount()`, `.setVol()`,
`.setPos()`/`.seek()`. Events via `.onInitialized()`, `.onMetadata()`,
`.onProgress()`, `.onEnded()`, `.onError()`.

---

## STEP 2 — Music (MAIN/MUSIC1.S3M -> assets/music1.s3m)

- Source size: 600860 bytes. Copied size: 600860 bytes (exact match).
- SHA-256 of source and copy identical: `3393f848a4840b53aa247c4158e414bad848879e7f6059e214631c310e8dde54`
- Bytes at offset 0x2C: `SCRM` — confirmed (Scream Tracker 3 module magic).

No anomalies.

---

## STEP 3 — FC background picture (GLENZ/FC.UH -> assets/fc.bin)

- Size: 64784 bytes (exact match to spec).
- First 3 bytes: `55 68 31` = `"Uh1"` (confirmed).
- Full 16-byte header (hex): `556831004001c8000000000000000000` — bytes 3-4
  (`0040`) and 5-6 (`01c8`) decode as little-endian `0x0140`=320 and `0x00c8`=200,
  consistent with a 320x200 image following the header/palette.
- Palette: bytes[16:784] = 768 bytes (256 colors x 3), max component value found
  = 55 (within 6-bit 0-63 range, as expected for VGA palette).
- Image: bytes[784:64784] = 64000 bytes = 320*200 (exact match).
- Preview written to `tools/fc.png` (320x200 RGB, 8-bit palette entries x4).

### Distinct pixel value histogram (fc.bin image data)

Only indices 0-14 appear (all within the expected 0-15 range):

| pixel value | count |
|---|---|
| 0 | 35201 |
| 1 | 1033 |
| 2 | 7075 |
| 3 | 4466 |
| 4 | 1671 |
| 5 | 6769 |
| 6 | 3401 |
| 7 | 1189 |
| 12 | 3130 |
| 13 | 9 |
| 14 | 56 |

Distinct set: `{0,1,2,3,4,5,6,7,12,13,14}` — 11 distinct values, all ≤ 15 as
predicted. Visual inspection of `tools/fc.png` shows a purple checkerboard
floor/ground plane, consistent with "FC" = floor/checker background used
behind the glenz object.

No anomalies.

---

## STEP 4 — Title picture (BEG/SRTITLE.LBM)

File is **FORM PBM** (chunky, NOT planar ILBM) — confirmed via bytes 8-12 =
`"PBM "`.

### BMHD fields

| field | value |
|---|---|
| width | 320 |
| height | 400 |
| x | 0 |
| y | 0 |
| nPlanes | 8 |
| masking | 0 (no mask) |
| compression | 1 (ByteRun1 / PackBits) |
| transparentColor | 2 |
| xAspect | 5 |
| yAspect | 6 |
| pageWidth | 320 |
| pageHeight | 400 |

Since this is FORM PBM, `nPlanes=8` simply means 8 bits/pixel chunky (256-color
indexed), not 8 separate bitplanes to interleave — so no plane-to-chunky
conversion was needed for this file (that codepath was implemented in
`tools/parse_lbm.py` for completeness but not exercised).

### CMAP

- Length: 768 bytes (256 colors x 3).
- Max component value found: **255** — i.e. this CMAP already stores full
  8-bit RGB values (not the 0-63 VGA convention used by FC.UH). Per spec, the
  PNG preview therefore uses these values **as-is** rather than x4.

### Other chunks present (besides BMHD/CMAP/BODY)

`DPPS` (110 bytes), sixteen `CRNG` chunks (8 bytes each, color-cycling range
info — unused for a static render), and `TINY` (4229 bytes, a Deluxe Paint
thumbnail — unused).

### BODY decoding

- ByteRun1 (PackBits) decoded row-by-row (320 bytes/row, width already even so
  no padding byte needed) for 400 rows = 128000 pixel bytes.
- Distinct pixel value count: **57** (values sampled: 1,2,3,14-42,...).

### Outputs

- `assets/srtitle.bin` = 768 bytes (CMAP, stored exactly as in file, full 8-bit
  values) + 128000 bytes (320x400 chunky pixels, row-major) = 128768 bytes
  total.
- `tools/srtitle.png` — visually confirmed to be the "SECOND REALITY" logo
  artwork with the werewolf/glenz creature, rendered correctly with the
  as-is (non-multiplied) palette.

No anomalies — the "either ILBM or PBM" branch resolved to PBM, and the
render came out correct on the first attempt, confirming the chunk parsing,
ByteRun1 decoding, and CMAP interpretation were all correct.

---

## STEP 5 — Sine tables

### GLENZ/MATHSIN.INC

Total `dw`/`dd` value count in file order: **5525**.

LABEL lines found, with count of values preceding each (i.e. each label's
value-offset into the flat array):

| line | label text | values before it (offset) |
|---|---|---|
| 1 | `sintable16 LABEL WORD` | 0 |
| 92 | `costable16 LABEL WORD` | 900 |
| 456 | `tantable32 LABEL DWORD` | 4501 |

Parsing notes / anomalies handled:
- Line 362 has an inline comment: `dw -571, ..., -56;(cosine continued)` —
  the trailing `;(cosine continued)` was stripped before integer parsing.
- The file also uses `dd` (not just `dw`) for `tantable32` (32-bit values) and
  for one standalone sentinel `dd -99999999` placed right after an `ALIGN 4`
  directive, immediately before the `tantable32` label. This sentinel is
  included in the flat array in file order (it falls at the end of the
  costable16 region, offset 4500).
- The very last line of the file is an assembler fill directive:
  `dd 1024-900 dup(99999999)` — expanded programmatically to 124 repetitions
  of the value 99999999 (evaluating the count expression `1024-900`). This
  pads `tantable32` out to exactly 1024 entries, reconciling with
  `5525 - 4501 = 1024`.

Derived section lengths (offset deltas): sintable16 = 900 values (a single
quarter-circle, 0-899, i.e. 3600 units/circle / 4), costable16 = 3601 values
(900 to 4501 — a full 3600-entry circle table plus the trailing `-99999999`
sentinel), tantable32 = 1024 values (4501 to 5525 — 900 real + 124
`dup`-filled sentinels for the near-90-degree/undefined region).

### GLENZ/SIN1024.INC

- Exactly one LABEL line: `_sin1024 LABEL WORD` at value-offset 0.
- Total value count: **1024** (matches expected exactly).

### Validation

| check | expected | found | pass? |
|---|---|---|---|
| sin1024[0] | 0 | 0 | yes |
| sin1024[256] | 256 | 256 | yes |
| len(sin1024) | 1024 | 1024 | yes |

sintable16 samples at offsets relative to the `sintable16` label (0-based
index into the flat array starting at that label):

| offset | value found | rough expectation (1.15 fixed-point, 3600 units/circle) |
|---|---|---|
| 0 | 0 | 0 |
| 450 | 23170 | ~23170 (sin 45 deg) |
| 900 | 32767 | ~32767 (sin 90 deg, max positive 15-bit) |
| 1800 | 0 | 0 (sin 180 deg) |
| 2700 | -32766 | ~-32767 (sin 270 deg) — off by 1 from the naive expectation, this is the actual fixed-point table value, not adjusted |

All values are consistent with a signed 1.15 fixed-point sine table scaled to
3600 units per full circle (0.1 deg per unit), confirming this is
`MATHSIN.INC`'s `sintable16`. No fudging was applied — the offset-2700 value
of -32766 (vs. a naive expectation of -32767) is reported exactly as found in
the source file.

### Output

`assets/tables.json` (39035 bytes, compact/no pretty-print) with keys:
- `"mathsin_flat"`: flat array of all 5525 `dw`/`dd` values from MATHSIN.INC.
- `"labels"`: `{"sintable16": 0, "costable16": 900, "tantable32": 4501, "_sin1024": 0}`
- `"sin1024"`: flat array of 1024 values from SIN1024.INC.

No unresolved anomalies.

---

## Summary of anomalies encountered (all resolved)

1. `MATHSIN.INC` line 362 has an inline `;` comment appended directly to the
   last numeric value with no space — required explicit comment stripping.
2. `MATHSIN.INC`'s `tantable32` section uses assembler `dup()` repeat syntax
   (`1024-900 dup(99999999)`) rather than literal comma-separated values —
   required evaluating the count expression and expanding it.
3. `MATHSIN.INC` mixes `dw` (16-bit) and `dd` (32-bit) directives across its
   three tables — the parser handles both uniformly as "extract every
   comma-separated integer from every dw/dd line."
4. `SRTITLE.LBM` turned out to be FORM **PBM** (chunky), not ILBM (planar) —
   handled by the PBM branch of the parser; the ILBM planar-to-chunky branch
   was implemented but not exercised by this file.
5. `SRTITLE.LBM`'s CMAP stores full 8-bit (0-255) RGB directly rather than the
   6-bit (0-63) VGA convention used by `FC.UH` — detected via
   `max(cmap) > 63` and the PNG preview uses the values as-is per the spec.

All other steps matched expected sizes/magic bytes exactly with no surprises.
