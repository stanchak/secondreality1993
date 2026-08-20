// Second Reality — U2A ("Alkutekstit II"): the spaceship flyby.
// A faithful port of VISU's 3D object engine (VISU.C + ACALC.ASM + ADRAW.ASM)
// as used by VISU/C/U2A.C: parse the ship models, interpret the keyframe
// animation byte-code, transform + project + clip + cull + flat-shade the
// polygons over the U2ABG background. Software-rendered into an indexed
// framebuffer, same as the intro's display path.
//
// Original source is public domain (Unlicense, 2013 anniversary release).

const UNIT = 16384;               // matrices are 1.14 fixed-point
const NEWLIGHT = [12118, 10603, 3030];   // unit light vector (ADRAW.ASM)
const W = 320, H = 200;
// Projection, exactly as U2A.C sets it up:
//   vid_window(0,319, 25,174, 512, ...) -> projaddx=159, projaddy=99, near z=512,
//   and the 3D scene clips to rows 25..174 (the background's content band).
//   vid_cameraangle(fov=0x2200) -> AVID.ASM computes
//     projmulx = ((projclipx[MAX]-projaddx) * avistan[68]) >> 8
//              = (160 * 577) >> 8 = 360
//     projmuly = (projmulx * projaspect) >> 8
//   U2A.C calls vid_init(3), which is AVIDM1.ASM's m1o_init, and every m1*
//   initialiser sets **projaspect = 225** (only AVIDM2's 640x400 mode uses
//   256). So projmuly = (360 * 225) >> 8 = 316, NOT 360 — carrying x's value
//   over to y stretched the whole flyby vertically by 360/316 = 13.9%.
//   The fov is a per-frame value in the animation stream, but all 521 frames
//   of U2A.0AB carry the same 0x2200, so these stay compile-time constants.
//   Screen y grows DOWN: sy = y*PMY/z + ADY (calc_project adds, no flip).
const PMX = 360, PMY = 316, ADX = 159, ADY = 99, NEARZ = 512;
const CLIPY0 = 25, CLIPY1 = 174;

let geo = null, anim = null, bg = null;
export let u2aPalette = null;     // Uint8Array(768) 6-bit
let co = [];                      // object instances: {model,on,m[9],pos[3]}
let sp = 0;                       // animation stream cursor

export async function loadU2A() {
  const [g, a, b] = await Promise.all([
    fetch('assets/u2a_geo.json'), fetch('assets/u2a_anim.bin'), fetch('assets/u2a_bg.bin')]);
  geo = await g.json();
  anim = new Uint8Array(await a.arrayBuffer());
  bg = new Uint8Array(await b.arrayBuffer());
  u2aPalette = Uint8Array.from(geo.palette);
  // pre-convert model polys' vertex-index arrays are already plain arrays
  co = geo.co.map((mi, i) => ({ model: mi, on: i === 0 ? 1 : 0, m: new Int32Array(9), pos: [0, 0, 0] }));
}

// end-of-stream: the original exits its render loop the moment the anim hits
// the end marker, so the state set by the final events is never drawn — the
// screen holds the pure background while the next part loads. Turning all
// objects off reproduces that (the ship vanishes into the horizon).
export function u2aAllOff() {
  for (let i = 1; i < co.length; i++) co[i].on = 0;
}

export function u2aReset() {
  sp = 0;
  for (const c of co) { c.m.fill(0); c.pos = [0, 0, 0]; c.on = (co.indexOf(c) === 0) ? 1 : 0; }
}

// --- animation byte-code interpreter (port of U2A.C main-loop inner while) ---
function gb() { return anim[sp++]; }
function lsget(f) {
  f &= 3;
  if (f === 0) return 0;
  if (f === 1) { const v = gb(); return v >= 128 ? v - 256 : v; }
  if (f === 2) { const v = gb() | (gb() << 8); return v >= 32768 ? v - 65536 : v; }
  const v = gb() | (gb() << 8) | (gb() << 16) | (gb() << 24); return v | 0;
}
// advance the animation one frame; returns fov, or null at end of scene
export function u2aStep() {
  let onum = 0;
  for (;;) {
    if (sp >= anim.length) return null;
    let a = gb();
    if (a === 0xff) {
      a = gb();
      if (a <= 0x7f) return a << 8;      // end of frame (fov)
      if (a === 0xff) return null;        // end of scene
    }
    if ((a & 0xc0) === 0xc0) { onum = (a & 0x3f) << 4; a = gb(); }
    onum = (onum & 0xff0) | (a & 0xf);
    const r = co[onum];
    if ((a & 0xc0) === 0x80) r.on = 1;
    else if ((a & 0xc0) === 0x40) r.on = 0;
    let pflag = 0;
    const s = a & 0x30;
    if (s === 0x10) pflag |= gb();
    else if (s === 0x20) { pflag |= gb(); pflag |= gb() << 8; }
    else if (s === 0x30) { pflag |= gb(); pflag |= gb() << 8; pflag |= gb() << 16; }
    r.pos[0] += lsget(pflag);
    r.pos[1] += lsget(pflag >> 2);
    r.pos[2] += lsget(pflag >> 4);
    const wide = (pflag & 0x40) ? 2 : 1;
    for (let b = 0; b < 9; b++) if (pflag & (0x80 << b)) r.m[b] += lsget(wide);
  }
}

// --- matrix math (row-major 1.14, >>14) ---
// ACALC.ASM reduces every one of these products with `sar ebx,unitshr` (or the
// equivalent `shrd ebx,ecx,unitshr` on a sign-extended 64-bit pair) — an
// ARITHMETIC shift, which rounds toward -infinity. Dividing and truncating
// toward zero instead biases every negative coordinate up by one unit, so the
// two halves of a model drift apart by a quantum. Math.floor is the shift.
const shr14 = (v) => Math.floor(v / UNIT);
function rotvec(m, x, y, z) {
  return [shr14(m[0] * x + m[1] * y + m[2] * z),
          shr14(m[3] * x + m[4] * y + m[5] * z),
          shr14(m[6] * x + m[7] * y + m[8] * z)];
}
function matmul(a, b) {
  const r = new Int32Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    r[i * 3 + j] = shr14(a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]);
  return r;
}
// diffuse shade from a rotated normal -> offset 1..30 (ADRAW.ASM
// normallight: brightness=(dot>>21)+128 clamped 0..255; F_SHADE32: >>3, 1..30)
function calclight(nx, ny, nz) {
  const dot = nx * NEWLIGHT[0] + ny * NEWLIGHT[1] + nz * NEWLIGHT[2];
  let b = Math.floor(dot / 2097152) + 128;   // dot >> 21, then +128
  b = b < 0 ? 0 : b > 255 ? 255 : b;
  const s = b >> 3;
  return s < 1 ? 1 : s > 30 ? 30 : s;
}

// render the current scene into fb (Uint8Array(320*200)) over the background.
// Structure mirrors the original main loop: objects are z-sorted by their
// center distance and drawn far-to-near; WITHIN an object, polygons draw in
// chunk order with back-face culling (vis_drawobject uses precomputed ORD
// draw lists — for these flat/convex models chunk order is equivalent, and it
// keeps coplanar detail polys like the hull's lit windows on top).
export function u2aRender(fb) {
  fb.set(bg);
  const cam = co[0];
  const objs = [];
  for (let ci = 1; ci < co.length; ci++) {
    const ob = co[ci];
    if (!ob.on) continue;
    const model = geo.models[String(ob.model)];
    const M = matmul(cam.m, ob.m);
    const op = rotvec(cam.m, ob.pos[0], ob.pos[1], ob.pos[2]);
    const T = [op[0] + cam.pos[0], op[1] + cam.pos[1], op[2] + cam.pos[2]];
    // view-space vertices
    const vv = new Array(model.v.length);
    for (let i = 0; i < model.v.length; i++) {
      const v = model.v[i], rv = rotvec(M, v[0], v[1], v[2]);
      vv[i] = [rv[0] + T[0], rv[1] + T[1], rv[2] + T[2]];
    }
    // Object sort key, exactly U2A.C:297 — `b=o->pl[0][1]; // center vertex`
    // then calc_singlez(b, o->v0, o->r): the view-space z of ONE designated
    // vertex, the one READASC's calccenter() picked and stored in word 1 of the
    // object's ORD0 polylist (extract_u2a_assets.mjs carries it through as
    // `centre`). An average over all vertices is a different key and reorders
    // overlapping objects at grazing angles.
    objs.push({ model, M, vv, dist: vv[model.centre][2] });
  }
  objs.sort((a, b) => b.dist - a.dist);        // painter's between objects: far first
  for (const { model, M, vv } of objs) {
    // gouraud (F_DEFAULT sets F_GOURAUD): per-VERTEX shade from the vertex
    // normal, interpolated across each polygon by the fill.
    const vsh = new Float32Array(model.v.length);
    for (let i = 0; i < model.v.length; i++) {
      const n0 = model.n[model.vn[i]] || [0, 0, UNIT];
      const rn = rotvec(M, n0[0], n0[1], n0[2]);
      vsh[i] = calclight(rn[0], rn[1], rn[2]);
    }
    for (const poly of model.p) {
      const n0 = model.n[poly.n] || [0, 0, UNIT];
      const rn = rotvec(M, n0[0], n0[1], n0[2]);
      // near plane: calc_project CLAMPS z to NEARZ (it never clips vertices in
      // 3D); a poly wholly behind the near plane is dropped, the rest is left
      // to the 2D window clip in the scanline fill.
      const vp = poly.v.map(i => vv[i]);
      if (vp.every(p => p[2] < NEARZ)) continue;
      // back-face cull exactly like ADRAW checkculling: dot(rotated FACE
      // normal, view-space vertex) — visible when negative. (Not screen
      // winding: the hull's window polys are wound opposite their base face
      // but share its normal, and must show whenever the hull face does.)
      const cv = vp[0];
      if (rn[0] * cv[0] + rn[1] * cv[1] + rn[2] * cv[2] >= 0) continue;
      const pts = [];
      for (let k = 0; k < poly.v.length; k++) {
        const [x, y, z] = vp[k];
        const zz = z < NEARZ ? NEARZ : z;
        pts.push([x * PMX / zz + ADX, y * PMY / zz + ADY, vsh[poly.v[k]]]);  // y-down, per calc_project
      }
      fillPoly(fb, pts, poly.c);
    }
  }
}

// gouraud scanline fill: pts are [x, y, shade]; the shade (1..30) interpolates
// along edges and across each span; pixel = base color + shade.
function fillPoly(fb, pts, base) {
  let ymin = 1e9, ymax = -1e9;
  for (const p of pts) { if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1]; }
  // clip to the vid_window band (rows 25..174): the scene never draws over the
  // black margins of the background, exactly as in the original.
  ymin = Math.max(CLIPY0, Math.floor(ymin)); ymax = Math.min(CLIPY1, Math.ceil(ymax));
  for (let y = ymin; y <= ymax; y++) {
    const xs = [];
    for (let k = 0; k < pts.length; k++) {
      const [x1, y1, s1] = pts[k], [x2, y2, s2] = pts[(k + 1) % pts.length];
      if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) {
        const t = (y - y1) / (y2 - y1);
        xs.push([x1 + t * (x2 - x1), s1 + t * (s2 - s1)]);
      }
    }
    xs.sort((a, b) => a[0] - b[0]);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const [xl, sl] = xs[k], [xr, sr] = xs[k + 1];
      const xa = Math.max(0, Math.round(xl)), xb = Math.min(W - 1, Math.round(xr));
      if (xb < xa) continue;
      const ds = xr > xl ? (sr - sl) / (xr - xl) : 0;
      const row = y * W;
      for (let x = xa; x <= xb; x++) {
        let s = (sl + (x - xl) * ds) | 0;
        s = s < 1 ? 1 : s > 30 ? 30 : s;
        fb[row + x] = base + s;
      }
    }
  }
}
