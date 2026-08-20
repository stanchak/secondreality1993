// Second Reality — TUNNELI (the dot tunnel), port of TUNNELI/TUN10.PAS.
// 100 rings of 64 dots stream down a swaying tunnel: ring positions come from
// the SINIT.DAT sine/cosine tables, dot circles from the TUNNEL.DAT projection
// table (both shipped verbatim), radius by depth = 16384/(z*7+95). Each ring
// erases its previous dots (oldpos) and plots new ones; the camera is locked
// to ring 5, so the tunnel sways around the viewer. Runs 1060 vblanks.
// Original source is public domain (Unlicense, 2013 anniversary release).

const VEKE = 1060;                 // frame count to exit (TUN10 `veke`)
const VBLANK_HZ = 70;

let sinit = null, cosit = null;    // Int16 views of SINIT.DAT
let pcalc = null;                  // Int16Array(138*64*2) from TUNNEL.DAT
const sade = new Uint16Array(103); // radius index per depth

// mode 13h vram plus the offscreen tail: the original's rows[] table is
// bracketed by arrays holding 64000, so out-of-range dots land at offsets
// 64000..65535 — past the visible screen but inside the 64K VGA segment.
export const tunnelVram = new Uint8Array(65536);
export const tunnelPal = new Uint8Array(768);   // 6-bit, static

export async function loadTunnel() {
  const [tRes, sRes] = await Promise.all([
    fetch('assets/tunnel.dat'), fetch('assets/sinit.dat')]);
  pcalc = new Int16Array(await tRes.arrayBuffer());
  const sd = await sRes.arrayBuffer();
  sinit = new Int16Array(sd, 0, 4097);
  cosit = new Int16Array(sd, 4097 * 2, 2049);
  for (let z = 0; z <= 100; z++) sade[z] = Math.floor(16384 / (z * 7 + 95));
  // palette exactly as TUN10 writes it — including the 6-bit DAC masking
  // quirk: setrgb(64, 64,64,64) wraps to 0, so color 64 is BLACK.
  const put = (c, r, g, b) => { tunnelPal[c * 3] = r & 63; tunnelPal[c * 3 + 1] = g & 63; tunnelPal[c * 3 + 2] = b & 63; };
  for (let x = 0; x <= 64; x++) put(64 + x, 64 - x, 64 - x, 64 - x);
  for (let x = 0; x <= 64; x++) put(128 + x, (64 - x) * 3 >> 2, (64 - x) * 3 >> 2, (64 - x) * 3 >> 2);
  put(68, 0, 0, 0);
  put(132, 0, 0, 0);
  put(255, 0, 63, 0);
  console.log('[TUNNELI] tables loaded: pcalc 138x64 dots, sinit/cosit — the dot tunnel');
}

// ring queue {x,y,c} and per-dot previous screen offsets
const putX = new Int16Array(101), putY = new Int16Array(101), putC = new Uint8Array(101);
const oldpos = new Uint16Array(7501);
let frame = 0, sx = 0, sy = 0, tframeDone = -1, done = false;

export function tunnelReset() {
  putX.fill(0); putY.fill(0); putC.fill(0);
  oldpos.fill(0);
  tunnelVram.fill(0);
  frame = 0; sx = 0; sy = 0; tframeDone = -1; done = false;
}
export function tunnelEnded() { return done; }

// one vblank of the ring stream (the `for sync := 1 to frames` body)
function streamFrame() {
  const nx = (cosit[sy & 2047] - sinit[(sy * 3) & 4095] - cosit[sx & 2047]) << 16 >> 16;
  const ny = (sinit[(sx * 2) & 4095] - cosit[sx & 2047] + sinit[0]) << 16 >> 16;
  // move(putki[1], putki[0], ...): shift the queue down, append at [100]
  putX.copyWithin(0, 1); putY.copyWithin(0, 1); putC.copyWithin(0, 1);
  putX[100] = nx; putY[100] = ny;
  sy++; sx++;
  putC[99] = ((sy & 15) > 7) ? 128 : 64;
  if (frame >= VEKE - 102) putC[99] = 0;
  if (frame === VEKE) done = true; else frame++;
}

// one display frame: draw rings 80..4 (erase old dots, plot new)
function drawFrame() {
  let ry = 0;                            // oldpos cursor — advances ONLY for drawn rings
  const refX = putX[5], refY = putY[5];  // camera locked to ring 5
  for (let x = 80; x >= 4; x--) {
    const bbc = putC[x] + Math.round(x / 1.3);
    if (bbc < 64) continue;              // invisible ring: no erase, no draw, no ry advance
    const bx = (putX[x] - refX) << 16 >> 16;
    const by = (putY[x] - refY) << 16 >> 16;
    const base = sade[x] * 64 * 2;       // pcalc row for this radius
    for (let k = 0; k < 64; k++) {
      tunnelVram[oldpos[ry + k]] = 0;    // erase previous dot
      const di = (pcalc[base + k * 2] + bx) & 0xffff;
      let off = di;
      if (di <= 319) {
        const yy = by + pcalc[base + k * 2 + 1];
        // rows[] lookup with the padded-array trick: in range -> row offset,
        // out of range -> 64000 (offscreen), exactly like the original memory
        off = di + ((yy >= 0 && yy <= 200) ? yy * 320 : 64000);
        tunnelVram[off] = bbc;
      }
      oldpos[ry + k] = off;
    }
    ry += 64;
  }
}

// advance to tunnel-time tt (seconds since part start)
//
// Order matters. TUN10.PAS's main loop is
//     repeat  waitr;  {DRAW the current putki state};  {advance it `frames`
//             times};  until quit
// — it draws BEFORE stepping the ring queue, so vblank n displays the state
// after n advances, and the very first drawn frame is the all-zero initial
// state (every ring's bbc = 0+round(x/1.3) < 64, i.e. blank). Stepping first
// and drawing after ran the whole tunnel one frame ahead: every ring's colour
// band and swayed position belonged to the next vblank.
//
// drawFrame() also has to run for EVERY vblank, not once per call: a ring whose
// bbc drops below 64 is skipped without erasing its dots and without advancing
// the oldpos cursor, so the cursor's meaning depends on which rings were drawn
// on the immediately preceding frame. Skipping intermediate frames during
// catch-up leaves stale dots behind.
export function tunnelStepTo(tt, replay) {
  if (done) return false;
  const target = Math.floor(tt * VBLANK_HZ);
  let steps = target - tframeDone;
  if (steps <= 0) return true;
  if (steps > 35 && !replay) { tframeDone = target - 35; steps = 35; }
  for (let s = 0; s < steps && !done; s++) {
    tframeDone++;
    drawFrame();
    streamFrame();
  }
  return !done;
}
