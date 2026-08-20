// Second Reality — U2E, "Vector Part II / KewlComplex".
//
// Ported from VISU/C/U2E.C and the VISU engine (VISU.C, ACALC.ASM,
// ADRAW.ASM, ADRAWCLP.ASM and AVIDFILL.ASM).  Geometry, material flags,
// precomputed polygon-order lists, camera/object keyframes and the VGA DAC
// palette all come from the shipped MAIN/DATA/U2E.* files.  The source runs
// its animation stream at one keyframe per two 70 Hz vblanks (35 Hz).

const VBLANK_HZ = 70;
const UNIT = 16384;
const W = 320, H = 200;
const CLIP_X0 = 0, CLIP_X1 = 319;
const CLIP_Y0 = 25, CLIP_Y1 = 174;
const NEAR_Z = 512, FAR_Z = 9999999;
const ADD_X = 159, ADD_Y = 99;
// U2E.0AB ends every frame with FOV 0x1c00. AVID.ASM indexes avistan[56]:
//   projmulx=(319-159)*715>>8=446; projmuly=446*225>>8=391.
// Mode 11 inherits m1_init's 225/256 VGA pixel aspect (AVIDM1.ASM).
const PROJ_X = 446, PROJ_Y = 391;
const NEW_LIGHT = [12118, 10603, 3030];

const VF_UP = 1, VF_DOWN = 2, VF_LEFT = 4, VF_RIGHT = 8;
const VF_NEAR = 16, VF_FAR = 32;
const F_2SIDE = 0x0200;
const F_SHADE = 0x0c00;
const F_GOURAUD = 0x1000;

const FADE_WHITE_FRAMES = 33;
const WHITE_HOLD_A_FRAMES = 16;
const RASTER_SWITCH_FRAMES = 2;
const WHITE_HOLD_B_FRAMES = 16;
const FADE_SCENE_FRAMES = 33;
const EXIT_FADE_FRAMES = 16;

export const u2eVram = new Uint8Array(W * H);
export const u2eVram400 = new Uint8Array(W * 400);
export const u2ePal = new Uint8Array(768);

let geo = null;
let anim = null;
let sourcePalette = null;
let fadePalette = new Uint8Array(768);
let co = [];
let sp = 0;
let localFrame = 0;
let phase = 'fade-white';
let phaseFrame = 0;
let cadence = 0;
let animationFrames = 0;
let firstVectorFrame = true;
let done = false;
let doneAtLocal = null;
let mode400 = true;

export async function loadU2e() {
  const [geometryResponse, animationResponse] = await Promise.all([
    fetch('assets/u2e_geo.json'),
    fetch('assets/u2e_anim.bin'),
  ]);
  if (!geometryResponse.ok) throw new Error(`U2E geometry: HTTP ${geometryResponse.status}`);
  if (!animationResponse.ok) throw new Error(`U2E animation: HTTP ${animationResponse.status}`);
  geo = await geometryResponse.json();
  anim = new Uint8Array(await animationResponse.arrayBuffer());

  if (geo.instanceCount !== 58 || geo.instances.length !== geo.instanceCount) {
    throw new Error('U2E scene table does not match the shipped 58-instance scene');
  }
  if (geo.animation.frames !== 1801 || geo.animation.bytes !== anim.length) {
    throw new Error('U2E animation metadata/data mismatch');
  }
  sourcePalette = Uint8Array.from(geo.palette);
  // U2E.C patches these four entries after the white aperture transition.
  setPaletteColor(sourcePalette, 255, 0, 0, 0);
  setPaletteColor(sourcePalette, 252, 0, 0, 0);
  setPaletteColor(sourcePalette, 253, 63, 63, 63);
  setPaletteColor(sourcePalette, 254, 63, 63, 63);

  co = geo.instances.map((model, index) => ({
    model,
    on: false,
    matrix: new Int32Array(9),
    position: new Int32Array(3),
    index,
  }));
  console.log('[U2E] original VISU scene loaded: 58 instances, 42 models, 1801 frames');
}

function setPaletteColor(palette, index, red, green, blue) {
  const p = index * 3;
  palette[p] = red;
  palette[p + 1] = green;
  palette[p + 2] = blue;
}

function captureJellyScreen(previousVram, previousPal) {
  // U2E enters while JPLOGO's 320x400 tweaked mode is still active. The web
  // presenter keeps that exact raster until U2E changes the scan mode.
  u2eVram400.fill(0);
  if (previousVram?.length === W * 400) u2eVram400.set(previousVram);
  for (let y = 0; y < H; y++) {
    // JPLOGO's max-scanline register is zero: its 400 raster rows are 400
    // distinct VGA address rows. U2E later switches to double-scan, which
    // displays address rows 0..199 twice; it does not sample the even rows.
    u2eVram.set(u2eVram400.subarray(y * W, y * W + W), y * W);
  }
  fadePalette.fill(0);
  if (previousPal?.length === 768) fadePalette.set(previousPal);
  u2ePal.set(fadePalette);
}

function resetObjects() {
  for (const instance of co) {
    instance.on = false;
    instance.matrix.fill(0);
    instance.position.fill(0);
  }
}

export function u2eReset(previousVram, previousPal) {
  if (!geo || !anim) throw new Error('loadU2e() must finish before u2eReset()');
  sp = 0;
  localFrame = 0;
  phase = 'fade-white';
  phaseFrame = 0;
  cadence = 0;
  animationFrames = 0;
  firstVectorFrame = true;
  done = false;
  doneAtLocal = null;
  mode400 = true;
  resetObjects();
  captureJellyScreen(previousVram, previousPal);
}

function makeApertureRaster() {
  // Execute U2E.C:fadeset() as planar writes into page zero. This preserves
  // two non-obvious release quirks: the top 25 rows never write groups 64..79
  // (so their rightmost 64 pixels retain JPLOGO), and the `+252` top-row
  // memset spills into rows y+3 at x=48..111. The latter is not a typo here;
  // it is the literal pointer arithmetic in the shipped source.
  const writeGroup = (address, mask, value) => {
    const y = Math.floor(address / 80);
    const group = address % 80;
    if (y < 0 || y >= 400) return;
    const base = y * W + group * 4;
    for (let plane = 0; plane < 4; plane++) {
      if (mask & (1 << plane)) u2eVram400[base + plane] = value;
    }
  };
  const planarFill = (address, length, mask, value) => {
    for (let i = 0; i < length; i++) writeGroup(address + i, mask, value);
  };

  let y = 0;
  for (; y < 25; y++) {
    const row = y * 80;
    planarFill(row, 17, 15, 0);
    planarFill(row + 17, 47, 15, 252);
    writeGroup(row + 63, 14, 0);
    planarFill(row + 252, 16, 15, 0);
  }
  for (; y < 175; y++) {
    const row = y * 80;
    planarFill(row, 17, 15, 254);
    planarFill(row + 17, 47, 15, 253);
    writeGroup(row + 63, 14, 254);
    planarFill(row + 64, 16, 15, 254);
  }
  for (; y < 200; y++) {
    const row = y * 80;
    planarFill(row, 17, 15, 0);
    planarFill(row + 17, 47, 15, 252);
    writeGroup(row + 63, 14, 0);
    planarFill(row + 64, 16, 15, 0);
  }

  // The first 200 VGA address rows become the 200-line page when max-scanline
  // changes to double-scan after the following wait.
  u2eVram.set(u2eVram400.subarray(0, W * H));
}

function tryStartVectors(orderAtLocal) {
  const order = orderAtLocal ? orderAtLocal(localFrame / VBLANK_HZ) : 0;
  if (order <= 18) return;
  phase = 'vectors';
  phaseFrame = 0;
  cadence = 0;
  stepVectors(true);
}

function stepPrelude(orderAtLocal) {
  if (phase === 'fade-white') {
    // for(a=3; a<768-6; a++) fpal[a]+=2, saturated
    for (let i = 3; i < 762; i++) fadePalette[i] = Math.min(63, fadePalette[i] + 2);
    u2ePal.set(fadePalette);
    if (++phaseFrame >= FADE_WHITE_FRAMES) {
      phase = 'white-hold-a';
      phaseFrame = 0;
    }
    return;
  }
  if (phase === 'white-hold-a') {
    if (++phaseFrame >= WHITE_HOLD_A_FRAMES) {
      makeApertureRaster();
      phase = 'raster-switch';
      phaseFrame = 0;
    }
    return;
  }
  if (phase === 'raster-switch') {
    // The two dis_waitb() calls around the VGA max-scanline change.
    if (phaseFrame === 0) mode400 = false;
    if (++phaseFrame >= RASTER_SWITCH_FRAMES) {
      phase = 'white-hold-b';
      phaseFrame = 0;
    }
    return;
  }
  if (phase === 'white-hold-b') {
    if (++phaseFrame >= WHITE_HOLD_B_FRAMES) {
      phase = 'fade-scene';
      phaseFrame = 0;
    }
    return;
  }
  if (phase === 'fade-scene') {
    // Fade the aperture to black while indices 253/254 stay white.
    for (let i = 3; i < 759; i++) fadePalette[i] = Math.max(0, fadePalette[i] - 2);
    for (let i = 759; i < 765; i++) fadePalette[i] = Math.min(63, fadePalette[i] + 2);
    u2ePal.set(fadePalette);
    if (++phaseFrame >= FADE_SCENE_FRAMES) {
      u2ePal.set(sourcePalette);
      phase = 'wait-order';
      phaseFrame = 0;
      // The source's order poll is a busy loop after the final fade wait. If
      // the gate is already open it queues its first frame without consuming
      // another vblank.
      tryStartVectors(orderAtLocal);
    }
    return;
  }
  if (phase === 'wait-order') {
    // U2E.C spins on the music server until the restarted module advances
    // beyond order 18. No timeout exists in the original.
    tryStartVectors(orderAtLocal);
  }
}

function getByte() {
  if (sp >= anim.length) throw new Error('U2E animation stream overrun');
  return anim[sp++];
}

function getSigned(size) {
  size &= 3;
  if (size === 0) return 0;
  if (size === 1) {
    const value = getByte();
    return value & 0x80 ? value - 0x100 : value;
  }
  if (size === 2) {
    const value = getByte() | (getByte() << 8);
    return value & 0x8000 ? value - 0x10000 : value;
  }
  return (getByte() | (getByte() << 8) | (getByte() << 16) | (getByte() << 24)) | 0;
}

// Parse exactly one keyframe. Returns false only for the 0xff,0xff scene end.
function advanceAnimation() {
  let objectNumber = 0;
  for (;;) {
    let command = getByte();
    if (command === 0xff) {
      command = getByte();
      if (command <= 0x7f) {
        // U2E's 1801 frame markers are all 0x1c (FOV 0x1c00).
        animationFrames++;
        return true;
      }
      if (command === 0xff) return false;
    }
    if ((command & 0xc0) === 0xc0) {
      objectNumber = (command & 0x3f) << 4;
      command = getByte();
    }
    objectNumber = (objectNumber & 0xff0) | (command & 0x0f);
    const instance = co[objectNumber];
    if (!instance) throw new Error(`U2E animation selects invalid object ${objectNumber}`);
    if ((command & 0xc0) === 0x80) instance.on = true;
    else if ((command & 0xc0) === 0x40) instance.on = false;

    let flags = 0;
    const flagBytes = (command >> 4) & 3;
    for (let i = 0; i < flagBytes; i++) flags |= getByte() << (i * 8);
    instance.position[0] = (instance.position[0] + getSigned(flags)) | 0;
    instance.position[1] = (instance.position[1] + getSigned(flags >> 2)) | 0;
    instance.position[2] = (instance.position[2] + getSigned(flags >> 4)) | 0;
    const matrixWidth = flags & 0x40 ? 2 : 1;
    for (let i = 0; i < 9; i++) {
      if (flags & (0x80 << i)) instance.matrix[i] = (instance.matrix[i] + getSigned(matrixWidth)) | 0;
    }
  }
}

function stepVectors(paint) {
  // U2E.C converts vblank lateness to `(repeat+1)/2` keyframes: at speed this
  // is one animation frame every two 70 Hz ticks.
  if (cadence++ & 1) return;

  if (firstVectorFrame) {
    // The final U2E.C buffering code deliberately skips its first draw, then
    // advances the animation. The white aperture remains visible for it.
    firstVectorFrame = false;
  } else if (paint || (anim[sp] === 0xff && anim[sp + 1] === 0xff)) {
    renderScene();
  }

  if (!advanceAnimation()) {
    // The source resets matrices here, but the already queued last rendered
    // page remains visible throughout the exit fade.
    phase = 'exit-fade';
    phaseFrame = 0;
    fadePalette.set(sourcePalette);
  }
}

function stepExitFade() {
  // U2E.C reads the current DAC, adds four to every component, and writes it
  // starting at DAC index 255 (rather than zero). The VGA address wraps, so
  // source color 0 lands at 255 and source colors 1..255 land at 0..254.
  for (let i = 0; i < 768; i++) fadePalette[i] = Math.min(63, fadePalette[i] + 4);
  u2ePal.set(fadePalette.subarray(3), 0);
  u2ePal.set(fadePalette.subarray(0, 3), 765);
  if (++phaseFrame >= EXIT_FADE_FRAMES) {
    done = true;
    doneAtLocal = localFrame / VBLANK_HZ;
  }
}

const signed16 = value => (value << 16) >> 16;
const fixed = value => Math.floor(value / UNIT);
const idiv = (numerator, denominator) => Math.trunc(numerator / denominator);

function multiplyMatrices(left, right) {
  const result = new Int32Array(9);
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      // ACALC.ASM's mulmacro accumulates signed 32-bit products then SARs 14.
      let sum = Math.imul(left[row * 3], right[column]);
      sum = (sum + Math.imul(left[row * 3 + 1], right[column + 3])) | 0;
      sum = (sum + Math.imul(left[row * 3 + 2], right[column + 6])) | 0;
      result[row * 3 + column] = sum >> 14;
    }
  }
  return result;
}

function rotatePosition(matrix, point) {
  return [
    fixed(matrix[0] * point[0] + matrix[1] * point[1] + matrix[2] * point[2]),
    fixed(matrix[3] * point[0] + matrix[4] * point[1] + matrix[5] * point[2]),
    fixed(matrix[6] * point[0] + matrix[7] * point[1] + matrix[8] * point[2]),
  ];
}

function transformVertex(matrix, translation, vertex) {
  // calc_rotate reads only the low signed word of each composed matrix cell.
  const m0 = signed16(matrix[0]), m1 = signed16(matrix[1]), m2 = signed16(matrix[2]);
  const m3 = signed16(matrix[3]), m4 = signed16(matrix[4]), m5 = signed16(matrix[5]);
  const m6 = signed16(matrix[6]), m7 = signed16(matrix[7]), m8 = signed16(matrix[8]);
  return [
    fixed(m0 * vertex[0] + m1 * vertex[1] + m2 * vertex[2]) + translation[0],
    fixed(m3 * vertex[0] + m4 * vertex[1] + m5 * vertex[2]) + translation[1],
    fixed(m6 * vertex[0] + m7 * vertex[1] + m8 * vertex[2]) + translation[2],
  ];
}

function rotateNormal(matrix, normal) {
  return [
    fixed(signed16(matrix[0]) * normal[0] + signed16(matrix[1]) * normal[1] + signed16(matrix[2]) * normal[2]),
    fixed(signed16(matrix[3]) * normal[0] + signed16(matrix[4]) * normal[1] + signed16(matrix[5]) * normal[2]),
    fixed(signed16(matrix[6]) * normal[0] + signed16(matrix[7]) * normal[1] + signed16(matrix[8]) * normal[2]),
  ];
}

function transformedZ(matrix, translationZ, vertex) {
  return fixed(matrix[6] * vertex[0] + matrix[7] * vertex[1] + matrix[8] * vertex[2]) + translationZ;
}

function projected(vertex) {
  const z = vertex[2];
  let divisor = z;
  let flags = 0;
  if (z < NEAR_Z) { flags |= VF_NEAR; divisor = NEAR_Z; }
  else if (z > FAR_Z) flags |= VF_FAR;
  const y = idiv(vertex[1] * PROJ_Y, divisor) + ADD_Y;
  const x = idiv(vertex[0] * PROJ_X, divisor) + ADD_X;
  if (y > CLIP_Y1) flags |= VF_DOWN;
  if (y < CLIP_Y0) flags |= VF_UP;
  if (x > CLIP_X1) flags |= VF_RIGHT;
  if (x < CLIP_X0) flags |= VF_LEFT;
  return { x: signed16(x), y: signed16(y), flags };
}

function light(normal, flags) {
  const dot = normal[0] * NEW_LIGHT[0] + normal[1] * NEW_LIGHT[1] + normal[2] * NEW_LIGHT[2];
  let brightness = Math.floor(dot / 2097152) + 128; // normallight: dot >> 21
  brightness = Math.max(0, Math.min(255, brightness));
  const shadeFlag = (flags & F_SHADE) >> 10;
  let shade = shadeFlag ? brightness >> (6 - shadeFlag) : 0;
  return Math.max(1, Math.min(30, shade));
}

function appendUnique(points, point) {
  const previous = points[points.length - 1];
  if (!previous || previous.x !== point.x || previous.y !== point.y) points.push(point);
}

function clipNear(points) {
  // ADRAWCLP.ASM:ZCLIPCLIP does a signed 32-bit interpolation in object
  // space, then projects the generated vertex with integer IDIV.  Its
  // ZCLIPADDVX macro deliberately copies the last emitted Gouraud word
  // instead of interpolating it.
  const result = [];
  let previous = points[points.length - 1];
  let previousInside = previous.z >= NEAR_Z;
  for (const current of points) {
    const currentInside = current.z >= NEAR_Z;
    if (currentInside !== previousInside) {
      let far = previous, near = current;
      if (far.z < near.z) [far, near] = [near, far];
      const divisor = far.z - near.z;
      const multiplier = far.z - NEAR_Z;
      const vx = far.vx + idiv((near.vx - far.vx) * multiplier, divisor);
      const vy = far.vy + idiv((near.vy - far.vy) * multiplier, divisor);
      appendUnique(result, {
        vx, vy, z: NEAR_Z,
        x: signed16(idiv(vx * PROJ_X, NEAR_Z) + ADD_X),
        y: signed16(idiv(vy * PROJ_Y, NEAR_Z) + ADD_Y),
        gr: result.length ? result[result.length - 1].gr : 0,
      });
    }
    if (currentInside) appendUnique(result, current);
    previous = current;
    previousInside = currentInside;
  }
  return result;
}

function clipEdge(points, inside, intersection) {
  if (points.length === 0) return points;
  const result = [];
  let previous = points[points.length - 1];
  let previousInside = inside(previous);
  for (const current of points) {
    const currentInside = inside(current);
    if (currentInside !== previousInside) appendUnique(result, intersection(previous, current));
    if (currentInside) appendUnique(result, current);
    previous = current;
    previousInside = currentInside;
  }
  return result;
}

function fixedClipOther(lowerCoord, upperCoord, lowerOther, upperOther, limit) {
  const multiplier = idiv((limit - lowerCoord) * UNIT, upperCoord - lowerCoord);
  const delta = signed16(upperOther - lowerOther);
  return signed16(lowerOther + (Math.imul(delta, multiplier) >> 14));
}

function clipAtX(a, b, x) {
  let lower = a, upper = b;
  if (lower.x > upper.x) [lower, upper] = [upper, lower];
  return {
    x: signed16(x),
    y: fixedClipOther(lower.x, upper.x, lower.y, upper.y, x),
    gr: fixedClipOther(lower.x, upper.x, lower.gr, upper.gr, x),
  };
}

function clipAtY(a, b, y) {
  let lower = a, upper = b;
  if (lower.y > upper.y) [lower, upper] = [upper, lower];
  return {
    x: fixedClipOther(lower.y, upper.y, lower.x, upper.x, y),
    y: signed16(y),
    gr: fixedClipOther(lower.y, upper.y, lower.gr, upper.gr, y),
  };
}

function clipScreen(points) {
  let out = clipEdge(points, point => point.y >= CLIP_Y0, (a, b) => clipAtY(a, b, CLIP_Y0));
  out = clipEdge(out, point => point.y <= CLIP_Y1, (a, b) => clipAtY(a, b, CLIP_Y1));
  out = clipEdge(out, point => point.x >= CLIP_X0, (a, b) => clipAtX(a, b, CLIP_X0));
  return clipEdge(out, point => point.x <= CLIP_X1, (a, b) => clipAtX(a, b, CLIP_X1));
}

function edgeState(from, to, gouraud) {
  const height = signed16(to.y - from.y);
  if (height <= 0) return null;
  const start = ((signed16(from.x) << 16) | 0x8000) | 0;
  const end = ((signed16(to.x) << 16) | 0x8000) | 0;
  const state = {
    remaining: height,
    x: start,
    xadd: idiv((end - start) | 0, height) | 0,
    c: signed16(from.gr || 0),
    cadd: 0,
  };
  if (gouraud) state.cadd = signed16(idiv(signed16((to.gr || 0) - state.c), height));
  return state;
}

function fillGouraudSpan(y, left, right, color1, color2) {
  // AVIDFILL.ASM excludes the right edge. Its Gouraud filler handles the two
  // unpaired endpoint pixels separately, then quantizes the interior using
  // one-, two-, or four-pixel accuracy according to the fixed colour slope.
  const fillRight = right - 1;
  if (fillRight < left) return;
  const row = y * W;
  if (!(fillRight & 1)) u2eVram[row + fillRight] = (color2 >>> 8) & 0xff;
  if (left & 1) u2eVram[row + left] = (color1 >>> 8) & 0xff;

  const leftBlock = (left + 1) >> 1;
  const rightBlock = (fillRight - 1) >> 1;
  const blocks = rightBlock - leftBlock + 1;
  if (blocks <= 0) return;

  const diff = signed16(color1 - color2);
  const reciprocal = Math.min(65535, Math.floor(65536 / blocks));
  let adder = Math.floor(Math.abs(diff) * reciprocal / 65536);
  if (diff < 0) adder = -adder;
  adder = signed16(adder);
  const firstX = leftBlock * 2;

  if (adder >= 400 || adder <= -400) {
    const step = signed16(adder >> 1);
    for (let pixel = 0; pixel < blocks * 2; pixel++) {
      const c = signed16(color2 + Math.imul(step, blocks * 2 - pixel));
      u2eVram[row + firstX + pixel] = (c >>> 8) & 0xff;
    }
    return;
  }

  if (adder >= 128 || adder <= -128 || blocks < 4) {
    for (let block = 0; block < blocks; block++) {
      const c = signed16(color2 + Math.imul(adder, blocks - block));
      const value = (c >>> 8) & 0xff;
      u2eVram[row + firstX + block * 2] = value;
      u2eVram[row + firstX + block * 2 + 1] = value;
    }
    return;
  }

  const step = signed16(adder << 1);
  const generated = (blocks >> 1) + 1;
  const values = new Uint8Array(generated);
  for (let i = 0; i < generated; i++) {
    const c = signed16(color2 + Math.imul(step, generated - 1 - i));
    values[i] = (c >>> 8) & 0xff;
  }
  const firstGroup = firstX >> 2;
  for (let block = 0; block < blocks; block++) {
    const x = firstX + block * 2;
    const value = values[(x >> 2) - firstGroup];
    u2eVram[row + x] = value;
    u2eVram[row + x + 1] = value;
  }
}

function fillPolygon(points, color, gouraud) {
  if (points.length < 3) return;
  let top = 0;
  let bottomY = points[0].y;
  for (let i = 1; i < points.length; i++) {
    if (points[i].y < points[top].y) top = i;
    if (points[i].y > bottomY) bottomY = points[i].y;
  }
  if (points[top].y === bottomY) return;

  let leftIndex = top, rightIndex = top;
  let leftEdge = null, rightEdge = null;
  let currentY = points[top].y;
  const previousIndex = index => (index + points.length - 1) % points.length;
  const nextIndex = index => (index + 1) % points.length;

  while (currentY < bottomY) {
    while (!leftEdge || leftEdge.remaining === 0) {
      const next = previousIndex(leftIndex);
      if (points[next].y < points[leftIndex].y) return;
      leftEdge = edgeState(points[leftIndex], points[next], gouraud);
      leftIndex = next;
      if (leftEdge) break;
    }
    while (!rightEdge || rightEdge.remaining === 0) {
      const next = nextIndex(rightIndex);
      if (points[next].y < points[rightIndex].y) return;
      rightEdge = edgeState(points[rightIndex], points[next], gouraud);
      rightIndex = next;
      if (rightEdge) break;
    }
    const count = Math.min(leftEdge.remaining, rightEdge.remaining);
    for (let scanline = 0; scanline < count; scanline++) {
      if (gouraud) {
        leftEdge.c = signed16(leftEdge.c + leftEdge.cadd);
        rightEdge.c = signed16(rightEdge.c + rightEdge.cadd);
      }
      leftEdge.x = (leftEdge.x + leftEdge.xadd) | 0;
      rightEdge.x = (rightEdge.x + rightEdge.xadd) | 0;
      let lx = leftEdge.x >> 16, rx = rightEdge.x >> 16;
      let lc = leftEdge.c, rc = rightEdge.c;
      if (rx < lx) { [lx, rx] = [rx, lx]; [lc, rc] = [rc, lc]; }
      const y = currentY + scanline;
      if (rx !== lx) {
        if (gouraud) fillGouraudSpan(y, lx, rx, lc, rc);
        else u2eVram.fill(color & 0xff, y * W + lx, y * W + rx);
      }
    }
    currentY += count;
    leftEdge.remaining -= count;
    rightEdge.remaining -= count;
  }
}

function drawObject(item) {
  const { model, matrix, translation } = item;
  const vertices = model.vertices.map(vertex => transformVertex(matrix, translation, vertex));
  const projections = vertices.map(projected);
  let objectFlags = 0xff;
  for (const point of projections) objectFlags &= point.flags;
  if (objectFlags) return;

  const normals = model.normals.map(normal => rotateNormal(matrix, normal));
  let list = model.lists[0];
  let nearest = 0x7fffffff;
  for (let i = 1; i < model.lists.length; i++) {
    const candidate = model.lists[i];
    const z = vertices[candidate.sort][2];
    if (z < nearest) {
      nearest = z;
      list = candidate;
    }
  }

  for (const polygonIndex of list.polygons) {
    const polygon = model.polygons[polygonIndex];
    if (polygon.color === -1) continue;
    const faceNormal = normals[polygon.normal];
    const firstVertex = vertices[polygon.vertices[0]];
    if (!(polygon.flags & F_2SIDE)) {
      const facing = faceNormal[0] * firstVertex[0] + faceNormal[1] * firstVertex[1] + faceNormal[2] * firstVertex[2];
      if (facing >= 0) continue;
    }

    let andFlags = 0xff, orFlags = 0;
    const gouraud = !!(polygon.flags & F_GOURAUD);
    const points = polygon.vertices.map(vertexIndex => {
      const vertex = vertices[vertexIndex];
      const screen = projections[vertexIndex];
      andFlags &= screen.flags;
      orFlags |= screen.flags;
      const normalIndex = model.vertices[vertexIndex][3];
      const shade = gouraud && normalIndex >= 0 ? light(normals[normalIndex], polygon.flags) : 0;
      const gr = gouraud ? signed16(((polygon.color + shade) & 0xff) << 8) : 0;
      return { x: screen.x, y: screen.y, vx: vertex[0], vy: vertex[1], z: vertex[2], gr };
    });
    if (andFlags) continue;

    let clipped = points;
    if (orFlags & VF_NEAR) clipped = clipNear(clipped);
    if (clipped.length < 3) continue;
    if (orFlags & (VF_UP | VF_DOWN | VF_LEFT | VF_RIGHT)) clipped = clipScreen(clipped);
    if (clipped.length < 3) continue;
    const color = gouraud ? polygon.color : (polygon.color + light(faceNormal, polygon.flags)) & 0xff;
    fillPolygon(clipped, color, gouraud);
  }
}

function renderScene() {
  u2eVram.fill(255);
  const camera = co[0];
  const drawOrder = [];
  for (let i = 1; i < co.length; i++) {
    const instance = co[i];
    if (!instance.on) continue;
    const model = geo.models[String(instance.model)];
    const matrix = multiplyMatrices(camera.matrix, instance.matrix);
    const objectPosition = rotatePosition(camera.matrix, instance.position);
    const translation = [
      objectPosition[0] + camera.position[0],
      objectPosition[1] + camera.position[1],
      objectPosition[2] + camera.position[2],
    ];
    const centerVertex = model.vertices[model.lists[0].sort];
    let distance = transformedZ(matrix, translation[2], centerVertex);
    // U2E.C uses quoted NAME data directly: name[1]=='_' forces background
    // slabs to the far end of the painter order.
    if (model.name[1] === '_') distance = 1000000000;
    // Frames are tracked in doubled (70 Hz) units in the source.
    const sourceFrame = animationFrames * 2;
    if (sourceFrame > 900 * 2 && sourceFrame < 1100 * 2 &&
        model.name[1] === 's' && model.name[2] === '0' && model.name[3] === '1') {
      distance = 1;
    }
    drawOrder.push({ instanceIndex: i, model, matrix, translation, distance });
  }
  // U2E.C insertion-sorts with a strict `>` comparison; stable sort preserves
  // instance order at equal depths.
  drawOrder.sort((a, b) => b.distance - a.distance);
  for (const item of drawOrder) drawObject(item);
}

export function u2eEnded() { return done; }
export function u2eLocalFrames() { return localFrame; }
export function u2eMode400() { return mode400; }
export function u2eDurationS() {
  if (doneAtLocal != null) return doneAtLocal;
  return Math.max(0, localFrame) / VBLANK_HZ;
}

// Debug/verification metadata is derived by the checked-in converter, not an
// estimated duration. It is useful to the local harness without affecting the
// main player API.
export function u2eSourceState() {
  return { phase, localFrame, animationFrames, streamOffset: sp, streamBytes: anim ? anim.length : 0 };
}

export function u2eStepTo(timeSeconds, replay, _musplusAtLocal, orderAtLocal) {
  if (done) return false;
  const target = Math.floor(timeSeconds * VBLANK_HZ);
  let steps = target - localFrame;
  if (steps <= 0) return true;
  if (steps > 35 && !replay) steps = 35;

  for (let i = 0; i < steps && !done; i++) {
    localFrame++;
    const paint = i === steps - 1 || steps <= 2;
    if (phase === 'vectors') stepVectors(paint);
    else if (phase === 'exit-fade') stepExitFade();
    else stepPrelude(orderAtLocal);
  }
  return !done;
}
