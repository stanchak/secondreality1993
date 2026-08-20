// DDSTARS — "Desert Dream Stars (PSI)", the part the loader never runs.
//
// Port of DDSTARS/STARS.ASM + KOE.ASM (the shipped MAIN/DATA/DDSTARS.EXE
// unpacks byte-for-byte to DDSTARS/K.EXE, so the dev tree IS what shipped).
//
// MAIN/U2.ASM carries it as `exehid` under a `;txthid 'Hidden part'` comment.
// `whattorun` defaults to 07fh, so bit 7 — the only route to it — is clear; the
// only thing that sets bit 7 is partsmask[8] = 80h, reached by an undocumented
// command-line 'U'. `SECOND U` therefore runs this part and nothing else. The
// loader also starts MUSIC0 at order 70 for it (restartmus ax=0, bx=70), an
// eight-pattern section of the intro song fenced off by 255 end-markers that no
// other part reaches.
//
// It has NO music sync of any kind — no dis_sync, no dis_musrow, no musplus.
// Its whole timeline is `starframe`, one tick per dis_waitb, so 70 Hz. It ends
// only on dis_exit (any keypress), which is why it runs as long as you watch it.
//
// WHAT IT DOES
//
// A 512-star field (1024 later) projected into a 320x100 bitmap, drawn into a
// ring of 64 off-screen buffers — in the original, 512 KB of EMS mapped a page
// at a time through the page frame. The screen shows the current buffer up top
// and the buffer from 32 frames ago mirrored below it, which is where the
// reflection comes from: the bottom half of the screen is the top half of the
// starfield, half a second in the past.
//
// THE MODE, which is the one thing the source does not state outright:
// `mov ax,13 / int 10h` is DECIMAL 13 = mode 0Dh, 320x200 16-colour planar, 40
// bytes per scanline. Clearing bit 7 of CRTC 9 turns off scan doubling, so 400
// distinct rows are fetched at that same 40-byte pitch: 320x400, 16 colours.
// Every blit then steps di by 80 — two rows — so:
//
//   · stars land on the 200 EVEN rows (di = 0, 80, ... and 8000, 8080, ...)
//   · text lands on ODD rows (risetext writes at di = 80*k - 40)
//
// They interleave rather than overlap, which is exactly why the star blits'
// text-band clipping (`cmp di,cs:_nostar1`) could be commented out in the
// shipped build without the text being scribbled over. _nostar1/_nostar2 are
// still computed by risetext and read by nothing; they are not reproduced here.
//
// Colour comes from the planes: the two star buffers go to planes 0 and 1, so a
// star is colour 1, 2 or 3 by depth. The text writes with set/reset forcing
// plane 2 to all-ones, putting the whole text row into colours 4..7 — an opaque
// black bar with text on it, between the star rows.

const STARS = 512;
const STARS2 = 1024;
const VBLANK_HZ = 70;

const PITCH = 40;                 // mode 0Dh CRTC offset: bytes per scanline
export const DDSTARS_W = 320;
export const DDSTARS_H = 400;
const PAGE = 0x4000;              // starvram A000h/A400h = a 16384-byte step
const BUFS = 64;                  // EMS sub-buffers actually cycled (emmpage4 & 63)
const BUF = 8192;                 // one sub-buffer: plane A at +0, plane B at +4096

export const ddstarsVram = new Uint8Array(DDSTARS_W * DDSTARS_H);
export const ddstarsPal = new Uint8Array(768);

// The four VGA planes. Plane 3 is only ever written with zero (set/reset drives
// it from a value of 04h), so nothing ever reaches colours 8..15 — but it is
// modelled rather than assumed, because that is what makes the assumption
// checkable.
const plane = [new Uint8Array(65536), new Uint8Array(65536),
               new Uint8Array(65536), new Uint8Array(65536)];

// The EMS ring, flattened. Buffer n lived at logical page n>>1, offset
// (n&1)*8192 — two 8 KB buffers per 16 KB page. Here it is just one array.
const ems = new Uint8Array(BUFS * BUF);

const starZ = new Uint8Array(STARS2);      // the byte counter: depth, and life
const starX = new Int16Array(STARS2);
const starY = new Int16Array(STARS2);
const muldivX = new Int16Array(256);
const muldivY = new Int16Array(256);
const rows1 = new Uint16Array(200);

let textPic = null;                        // 320x200, two 40-byte planes per row

let seed = 0;
let emmpage4 = 0, starlimit = 0, starpalfade = 0, starframe = 0;
let startxtopen = 0, startxtclose = 0, startxtp0 = 0;
let writeOff = 0, dispOff = 0;
let esOff = -1;                            // where `es` points; risetext needs it
let frameDone = -1;
let inited = false;

// STARS.ASM's own LCG. `mul dword ptr cs:seed` puts the 64-bit product in
// EDX:EAX; the routine returns DX — the low word of the product's HIGH dword,
// not the usual (seed>>16) — and stores EAX+269EC3h as the next seed. The add
// does not carry into EDX, so the returned bits come from the product as-is.
// 0343FDh * 2^32 stays under 2^53, so plain doubles are exact here.
function random() {
  const prod = 0x343fd * seed;                      // exact: 0343FDh * 2^32 < 2^53
  const hi = Math.floor(prod / 4294967296);
  seed = (prod + 0x269ec3) % 4294967296;
  return hi & 0xffff;
}
const randCoord = () => ((random() & 1023) - 512);

// ---------------------------------------------------------------------------

export async function loadDdstars() {
  const res = await fetch('assets/ddstars_text.bin');
  textPic = new Uint8Array(await res.arrayBuffer());
  console.log(`[DDSTARS] hidden part: text picture ${textPic.length} bytes ` +
              `(320x200, 2 planes) — "A hidden part? No, just an experiment we left out..."`);
}

export function ddstarsReset() {
  seed = 0;
  plane.forEach(p => p.fill(0));            // init_stars clears 64K, all planes
  ems.fill(0);                              // clearsbu
  for (let i = 0; i < 200; i++) rows1[i] = i * PITCH;

  // cx runs 1024 down to 1 and the counter is `mov al,cl / dec al`, so the low
  // byte of cx minus one: a spread of every depth 0..255, four stars deep.
  for (let cx = STARS2, si = 0; cx >= 1; cx--, si++) {
    starZ[si] = ((cx & 0xff) - 1) & 0xff;
    starX[si] = randCoord();
    starY[si] = randCoord();
  }

  // muldiv[i] = (n*65536 / (150+4i)) >> 1, built by a 32/16 divide. The >>14 in
  // the projection is the matching half.
  for (let i = 0; i < 256; i++) {
    const bp = 150 + 4 * i;
    muldivY[i] = Math.floor(108 * 65536 / bp) >> 1;
    muldivX[i] = Math.floor(144 * 65536 / bp) >> 1;
  }

  emmpage4 = 0;
  starlimit = STARS;
  starpalfade = 0;
  starframe = 0;
  startxtopen = -9999;
  startxtclose = 10000;
  startxtp0 = 0;
  writeOff = 0;                             // starvram = 0a000h
  dispOff = 0;
  frameDone = -1;

  // init_stars primes the ring with 100 frames before the part is on screen,
  // which is also what leaves starlimit at 412 and ~100 stars already visible.
  for (let i = 0; i < 100; i++) { starfetch0(); staradd(); }
  esOff = -1;                               // es is an EMS selector at do_stars entry
  inited = true;
  ddstarsPal.fill(0);
}

// ---------------------------------------------------------------------------
// The EMS ring

function starfetch0() { emmpage4 = (emmpage4 + 1) & 63; return emmpage4 * BUF; }
function bufAt(n) { return ((n & 63)) * BUF; }

// ---------------------------------------------------------------------------
// staradd / staradd2 — advance every star and OR it into the ring buffer.
//
// Nothing clears these buffers. Buffer k only ever receives frames k, k+64,
// k+128 … so what accumulates in it is a handful of snapshots a full 64 frames
// apart, and the ring showing a different one every frame is what makes the
// field shimmer. Stars are respawned on wrap rather than moved, so the
// accumulation stays sparse instead of filling in.

function project(si, z) {
  // muldiv is indexed by the counter BEFORE the decrement (movzx bx, then sub).
  let prod = starY[si] * muldivY[z];
  let dy = (((prod >> 14) & 0xffff) + 100) & 0xffff;
  if (dy > 99) return -1;                   // unsigned ja: negatives fail too
  prod = starX[si] * muldivX[z];
  const dx = (((prod >> 14) & 0xffff) + 160) & 0xffff;
  if (dx > 319) return -1;
  return rows1[dy] + (dx >> 3) + ((0x80 >> (dx & 7)) << 16);   // offset | mask<<16
}

function staradd() {
  const base = emmpage4 * BUF;
  if (starlimit !== 0) starlimit = (starlimit - 1) & 0xffff;
  for (let bp = STARS, si = 0; bp > 0; bp--, si++) {
    const z = starZ[si];
    starZ[si] = (z - 2) & 0xff;
    if (z < 2) {                            // sub bl,2 borrowed: new position
      starX[si] = randCoord();
      starY[si] = randCoord();
      continue;
    }
    if (bp < starlimit) continue;
    const p = project(si, z);
    if (p < 0) continue;
    const off = p & 0xffff, mask = p >>> 16;
    // brightness reads the counter AFTER the decrement
    const zz = starZ[si];
    if (zz >= 180) ems[base + off] |= mask;
    else if (zz >= 110) ems[base + off + 4096] |= mask;
    else { ems[base + off] |= mask; ems[base + off + 4096] |= mask; }
  }
}

function staradd2() {
  const base = emmpage4 * BUF;
  const fs = bufAt(emmpage4 + 17);          // starfetch1
  if (starlimit !== 0) starlimit = (starlimit - 4) & 0xffff;
  for (let bp = STARS2, si = 0; bp > 0; bp--, si++) {
    const z = starZ[si];
    starZ[si] = (z - 2) & 0xff;
    if (z < 2) {
      starX[si] = randCoord();
      starY[si] = randCoord();
      continue;
    }
    if (bp < starlimit) continue;
    const p = project(si, z);
    if (p < 0) continue;
    const off = p & 0xffff, mask = p >>> 16;
    const zz = starZ[si];
    if (zz >= 180) { ems[base + off] |= mask; ems[fs + off] |= mask; }
    else if (zz >= 110) { ems[base + off + 4096] |= mask; ems[fs + off + 4096] |= mask; }
    else {
      ems[base + off] |= mask; ems[base + off + 4096] |= mask;
      ems[fs + off] |= mask; ems[fs + off + 4096] |= mask;
    }
  }
}

// ---------------------------------------------------------------------------
// risetext — the message unrolls upward, one row per frame, anchored at the
// bottom. Two blank rows lead it and one trails, which is what keeps the rising
// edge clean.
//
// It writes through `es`, and es still holds the page rendered on the PREVIOUS
// frame — the flip at the top of do_stars does not reload it. So the text goes
// into the page currently on screen while the stars go into the other one, and
// both pages end up carrying it, one frame apart. Reproduced rather than tidied
// up: it is why the text sits a frame behind the stars.

function fillRow(off, planesMask, value) {
  for (let i = 0; i < 40; i++) {
    for (let pl = 0; pl < 4; pl++) if (planesMask & (1 << pl)) plane[pl][off + i] = value;
  }
}

function risetext() {
  if (esOff < 0) return;                    // es is not a VRAM page yet
  let ax = startxtopen;
  if (ax < 99) { ax++; startxtopen = ax; }
  let dx = startxtclose;
  if (dx > 0) { dx--; startxtclose = dx; }
  if (dx < ax) ax = dx;                     // ax = startxtuse
  if (ax <= 0) return;
  if (ax <= 1) ax = 2;

  let di = 80 * (150 - ax);
  let si = startxtp0;                       // the asset already drops the 40h header
  let cx = ax - 1;

  di -= 40;
  // one blank row, all four planes
  fillRow(esOff + di, 0x0f, 0);
  di += 80;
  if (--cx === 0) {                         // @@tc0c: a wider clear and out
    for (let i = 0; i < 80; i++) for (let pl = 0; pl < 4; pl++) plane[pl][esOff + di + i] = 0;
    return;
  }
  fillRow(esOff + di, 0x0f, 0);
  di += 80;
  if (--cx === 0) return;                   // @@tc0
  if (--cx === 0) { trailRow(di); return; } // @@tc0b

  // Set/Reset: planes 2,3 driven from the value 04h, so plane 2 goes to all
  // ones and plane 3 to all zeros wherever a write lands. With map masks 0Dh
  // and 0Eh the CPU byte reaches plane 0 then plane 1.
  for (;;) {
    for (let i = 0; i < 40; i++) {
      const b = textPic[si + i];
      plane[0][esOff + di + i] = b;
      plane[2][esOff + di + i] = 0xff;
      plane[3][esOff + di + i] = 0x00;
    }
    si += 40;
    for (let i = 0; i < 40; i++) {
      const b = textPic[si + i];
      plane[1][esOff + di + i] = b;
      plane[2][esOff + di + i] = 0xff;
      plane[3][esOff + di + i] = 0x00;
    }
    si += 40;
    di += 80;
    if (--cx === 0) { trailRow(di); return; }
  }
}
function trailRow(di) { fillRow(esOff + di, 0x0f, 0); }

// ---------------------------------------------------------------------------
// The palette fade: 33 frames, entries 0..3 ramping and 4..7 fixed. `shl bl,3`
// carries out for starpalfade+1 >= 32, which is where the 255 comes from.

function fadePalette() {
  if (starpalfade > 32) return;
  const v = (starpalfade + 1) & 0xff;
  starpalfade = v;
  // shl bl,3 sets CF from bit 5, so anything from 32 up saturates to 255 and
  // the ramp is 8, 16 … 248 before that.
  const bl = ((v >> 5) & 1) ? 255 : (v << 3) & 0xff;
  const put = (c, r, g, b) => {
    ddstarsPal[c * 3] = r; ddstarsPal[c * 3 + 1] = g; ddstarsPal[c * 3 + 2] = b;
  };
  const s = v => (v * bl) >> 8;
  put(0, 0, 0, 0);
  put(1, s(17), s(21), s(26));               // 25*70/100, 31*70/100, 38*70/100
  put(2, s(25), s(32), s(38));               // 45*56/100, 58*56/100, 69*56/100
  put(3, s(42), s(53), s(63));               // 67*64/100, 84*64/100, 99*64/100
  put(4, 0, 0, 0);                           // the text colours do not fade
  put(5, 10, 20, 35);
  put(6, 20, 30, 45);
  put(7, 30, 40, 60);
}

// ---------------------------------------------------------------------------

function blitPlane(pl, src, dst, rows, srcStep) {
  const p = plane[pl];
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < 40; i++) p[dst + i] = ems[src + i];
    src += srcStep;
    dst += 80;                               // two scanlines at a 40-byte pitch
  }
}

function drawFrame() {
  // Page flip first: show the page just finished, write to the other.
  if (writeOff === 0) { writeOff = PAGE; dispOff = 0; }
  else { writeOff = 0; dispOff = PAGE; }

  fadePalette();

  starframe++;
  if (starframe === 1200) { startxtp0 = 80; startxtopen = -256; startxtclose = 1500; }
  if (starframe === 3200) { startxtp0 = 101 * 80; startxtopen = -256; startxtclose = 1500; }
  if (starframe === 1500) starlimit = STARS2;

  risetext();                                // still writing through the old es

  const cur = starfetch0();
  if (starframe > 1200) staradd2();
  else if (starframe > 900) { /* nothing added: the ring drains and the field empties */ }
  else staradd();

  esOff = writeOff;                          // es = starvram for the blits

  // top half: the buffer just written
  blitPlane(0, cur, writeOff, 100, 40);
  blitPlane(1, cur + 4096, writeOff, 100, 40);

  // bottom half: 32 frames ago, mirrored — read from row 99 upward
  const old = bufAt(emmpage4 + 32);
  blitPlane(0, old + 99 * 40, writeOff + 200 * PITCH, 100, -40);
  blitPlane(1, old + 99 * 40 + 4096, writeOff + 200 * PITCH, 100, -40);
}

// ---------------------------------------------------------------------------
// Present: read the displayed page back out through the planes, exactly as the
// DAC saw it. colour = p0 | p1<<1 | p2<<2 | p3<<3.

function present() {
  const p0 = plane[0], p1 = plane[1], p2 = plane[2], p3 = plane[3];
  let o = 0;
  for (let y = 0; y < DDSTARS_H; y++) {
    const row = dispOff + y * PITCH;
    for (let bx = 0; bx < 40; bx++) {
      const a = p0[row + bx], b = p1[row + bx], c = p2[row + bx], d = p3[row + bx];
      for (let bit = 7; bit >= 0; bit--) {
        ddstarsVram[o++] = ((a >> bit) & 1) | (((b >> bit) & 1) << 1) |
                           (((c >> bit) & 1) << 2) | (((d >> bit) & 1) << 3);
      }
    }
  }
}

export function ddstarsFrames() { return starframe; }

// Hooks for tools/validate_ddstars.mjs — the tables and the LCG are the two
// things worth asserting directly rather than inferring from pixels.
export const __test = {
  get muldivX() { return Array.from(muldivX); },
  get muldivY() { return Array.from(muldivY); },
  // Run the LCG from a given seed without disturbing the part's own state.
  randomSeq(n, from = 0) {
    const save = seed;
    seed = from;
    const out = [];
    for (let i = 0; i < n; i++) out.push(random());
    seed = save;
    return out;
  },
  // The same recurrence written out independently: EDX:EAX = 0343FDh * seed,
  // return DX, then seed = EAX + 269EC3h.
  expectedRandom(n) {
    let s = 0n;
    const out = [];
    for (let i = 0; i < n; i++) {
      const prod = 0x343fdn * s;
      out.push(Number((prod >> 32n) & 0xffffn));
      s = (prod + 0x269ec3n) & 0xffffffffn;
    }
    return out;
  },
  maxColourSeen() {
    let max = 0;
    for (let i = 0; i < ddstarsVram.length; i++) if (ddstarsVram[i] > max) max = ddstarsVram[i];
    return max;
  },
};

// dis_exit is a keypress, so the part has no end of its own. It runs as long as
// it is on screen.
export function ddstarsStepTo(tt, replay) {
  if (!inited) return true;
  const target = Math.floor(tt * VBLANK_HZ);
  let steps = target - frameDone;
  if (steps <= 0) return true;
  if (steps > 45 && !replay) { frameDone = target - 45; steps = 45; }
  for (let s = 0; s < steps; s++) { frameDone++; drawFrame(); }
  present();
  return true;
}
