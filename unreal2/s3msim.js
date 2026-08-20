// Second Reality — shared S3M utilities: the XOR de-scrambler (FC anti-rip
// protection on MUSIC0.S3M/MUSIC1.S3M's pattern data) plus a general-purpose
// order/row/speed/tempo simulator and the dis_musplus()/dis_musrow()
// music-position-gate model these parts poll to time their transitions.
//
// The original DOS demo gates part timing against the live-playing S3M
// module via a custom "DIS" (Demo Interrupt Server) API, called through a
// real-mode `int 0FCh`. DIS/DIS.ASM on its own looks like an unimplemented
// stub — its greeting text literally says "no music syncronization" — but its
// `include disint.asm` (DIS/DISINT.ASM) contains the real implementation,
// gated by `IFDEF INDEMO`, and the demo's actual kernel, MAIN/U2.ASM,
// assembles DISINT.ASM with `INDEMO=1` (`MAIN/U2.ASM:18,45`). The stub is a
// different, standalone build target that nothing in the shipped demo uses.
//
// The real `muscode_6` (DIS/DISINT.ASM:242-282, register mapping confirmed
// via the C-callable wrappers in DIS/DISC.ASM:91-123 — dis_musrow() reads
// BX, dis_musplus() reads DX, dis_muscode() reads AX):
//   AX = np_zinfo         (unrelated to musplus/musrow, a composer Z-command byte)
//   BX = np_row            -> dis_musrow(): current row of the playing pattern,
//                             identical to what any correct S3M player reports
//                             (libopenmpt's openmpt_module_get_current_row())
//   CX = np_ord             -> current order index (openmpt's get_current_order())
//   DX -> dis_musplus():
//     np_zplus==0: DX = -32                        (far from any marker)
//     np_zplus==1: DX = max(row-64, -32)            ("+++ marker coming")
//     np_zplus==2: DX = row<32 ? row : -32          ("+++ marker just passed")
// `np_zplus`'s own internal 0/1/2 transition timing isn't in source (it's
// set by STMIK's compiled tick handler, MAIN/STMIK.300 — a precompiled OMF
// library with no accompanying source anywhere in this repo). It doesn't
// need to be: the DX formula is redundant/clamped to -32 in exactly the
// rows where the transition's precise timing would matter, so the OBSERVED
// behavior of dis_musplus() is fully and unambiguously pinned by which
// "zone" (the order immediately before a marker, immediately after one, or
// neither) the current order falls in — see musplusAt() below.
//
// A "+++" marker is literal order-list byte value 254 (0xFE) — a standard
// Scream Tracker 3 "skip this order" sentinel (255/0xFF = "---", end of
// song) that Future Crew repurposed as an embedded sync beacon. The order
// list sits at a fixed file offset (0x60, length = the `ordnum` header
// field) and is NOT part of the scrambled region — directly readable off
// the raw fetched bytes, no descrambling needed.
//
// This exact model was cross-validated against glenz.js's own,
// independently-derived GLENZ gates: MFRAME0_S=
// 6.5187s at MUSIC1 order 2/row 45 (= max(45-64,-32) = -19, matching "fires
// when musplus first returns >= -19"), and END_FRAME's exit condition ("15
// rows before the second +++", i.e. musplus re-entering (-16,0), rows
// 49-63 of the order immediately before that marker). See
// tools/validate_s3msim.mjs, which must pass before this module is trusted
// for deriving any NEW gate.

export function descramble(ab) {
  const d = new Uint8Array(ab);
  const rd16 = o => d[o] | (d[o + 1] << 8);
  const key = i => { const n = (i >> 1) + 1; return (((n ^ (n >> 2)) << 3) | ((5 * i + 2) & 7)) & 0xff; };
  const ordnum = rd16(0x20), insnum = rd16(0x22), patnum = rd16(0x24);
  const pp = 0x60 + ordnum + insnum * 2;
  for (let p = 0; p < patnum; p++) {
    const ptr = rd16(pp + p * 2) * 16;
    if (!ptr) continue;
    const len = rd16(ptr);
    for (let i = 0; i < len - 2; i++) d[ptr + 2 + i] ^= key(i);
  }
  return ab;
}

// Raw (unscrambled) order list -- works on the bytes exactly as fetched.
export function orderList(bytes) {
  const d = new Uint8Array(bytes);
  const rd16 = o => d[o] | (d[o + 1] << 8);
  const ordnum = rd16(0x20);
  return Array.from(d.subarray(0x60, 0x60 + ordnum));
}

// Walk a DEscrambled module from an order/row entry point, honoring Axx (set speed),
// Txx (set tempo -- direct-set values 0x20+ only; MUSIC0/MUSIC1 aren't known
// to use tempo SLIDES (param<0x20), and none were encountered validating
// this against GLENZ's known-good numbers), Cxx (pattern break -- BCD target
// row, a ScreamTracker/ProTracker inheritance: target = (param>>4)*10 +
// (param&0xF)) and Bxx (position jump). 254 ("+++") order slots are skipped
// (they carry no pattern). Stops at the first 255 ("---") order slot.
// Row-duration formula: speed * 2.5 / tempo seconds/row (standard S3M
// timing, same formula techno.js's ROWS_PER_FRAME already uses).
export function buildTimeline(descrambledBytes, opts = {}) {
  const d = new Uint8Array(descrambledBytes);
  const rd16 = o => d[o] | (d[o + 1] << 8);
  const ordnum = rd16(0x20), insnum = rd16(0x22), patnum = rd16(0x24);
  const initSpeed = d[0x31], initTempo = d[0x32];
  const order = Array.from(d.subarray(0x60, 0x60 + ordnum));
  const pp = 0x60 + ordnum + insnum * 2;
  const patPtr = new Array(patnum);
  for (let p = 0; p < patnum; p++) patPtr[p] = rd16(pp + p * 2) * 16;

  // Decode one pattern into a 64-row array of {speed?,tempo?,posJump?,breakTo?}
  // -- only the fields that affect timing; notes/instruments/volumes/other
  // effects are consumed (to stay byte-aligned) but otherwise dropped.
  function decodePattern(ptr) {
    const rows = new Array(64);
    for (let r = 0; r < 64; r++) rows[r] = null;
    if (!ptr) return rows;
    let p = ptr + 2;
    const end = ptr + rd16(ptr);
    let cell = null, r = 0;
    while (p < end && r < 64) {
      const b = d[p++];
      if (b === 0) { rows[r] = cell; cell = null; r++; continue; }
      if (b & 0x20) p += 2;   // note + instrument
      if (b & 0x40) p += 1;   // volume
      if (b & 0x80) {
        const cmd = d[p++], param = d[p++];
        if (!cell) cell = {};
        if (cmd === 1) cell.speed = param;                                    // Axx
        else if (cmd === 2) cell.posJump = param;                             // Bxx
        else if (cmd === 3) cell.breakTo = (param >> 4) * 10 + (param & 0xf);  // Cxx
        else if (cmd === 20 && param >= 0x20) cell.tempo = param;             // Txx (direct set)
      }
    }
    return rows;
  }
  const patterns = patPtr.map(decodePattern);

  const rowsOut = [];
  let t = 0, speed = initSpeed || 6, tempo = initTempo || 125;
  // MAIN/U2.ASM deliberately starts MUSIC0 at hidden order 18 for U2E.
  // MUSIC0 has an earlier end marker, so that sequence can only be reached by
  // entering the order list there (the original player and libopenmpt both
  // support that direct order/row seek).
  let orderIdx = opts.startOrder ?? 0;
  let startRow = opts.startRow ?? 0;
  const maxOrders = opts.maxOrders || 4000;
  let guard = 0;
  while (orderIdx >= 0 && orderIdx < order.length && guard++ < maxOrders) {
    const o = order[orderIdx];
    if (o === 255) break;
    if (o === 254 || o >= patnum) { orderIdx++; continue; }
    const pat = patterns[o];
    let row = startRow; startRow = 0;
    let nextOrder = orderIdx + 1, jumped = false;
    while (row < 64) {
      const cell = pat[row];
      if (cell) {
        if (cell.speed) speed = cell.speed;
        if (cell.tempo) tempo = cell.tempo;
      }
      rowsOut.push({ orderIdx, row, patIdx: o, t, speed, tempo });
      t += speed * 2.5 / tempo;
      if (cell) {
        if (cell.posJump !== undefined) { nextOrder = cell.posJump; jumped = true; }
        if (cell.breakTo !== undefined) { startRow = cell.breakTo; jumped = true; }
      }
      row++;
      if (jumped) break;
    }
    orderIdx = nextOrder;
  }
  return { order, rows: rowsOut };
}

// The dis_musplus() model -- see header comment for the derivation.
//
// MARKER-FLANKED ORDERS. An order can have a "+++" on BOTH sides
// (MUSIC1 order index 26 is one), and the old code tested "marker coming" first,
// so such an order never reported the "marker just passed" side at all. The two
// np_zplus states are not in conflict there — they are complementary, and they
// AGREE at row 32:
//   zplus==1 ("coming"):      max(row-64,-32)  = -32 for rows 0..31, -32..-1 for 32..63
//   zplus==2 ("just passed"): row<32 ? row : -32 = 0..31 for rows 0..31, -32 for 32..63
// so each formula carries the information in one half and collapses to -32 in
// the other, and row 32 is the unique row where both give the same answer. The
// combined function below is therefore continuous and consistent with whichever
// state STMIK is actually in — which matters, because the exact row at which
// np_zplus flips 2->1 lives in MAIN/STMIK.300 and is not recoverable from source
// (see the header). Same lower-bound caveat as the single-sided cases.
export function musplusAt(order, orderIdx, row) {
  const justPassed = order[orderIdx - 1] === 254;
  const coming = order[orderIdx + 1] === 254;
  if (justPassed && coming) return row < 32 ? row : row - 64;
  if (coming) return Math.max(row - 64, -32);
  if (justPassed) return row < 32 ? row : -32;
  return -32;
}

export function timeAtRow(timeline, orderIdx, row) {
  for (const r of timeline.rows) if (r.orderIdx === orderIdx && r.row === row) return r.t;
  return null;
}

// Last timeline row whose start time is <= t (music-module-elapsed seconds).
export function rowAtTime(timeline, t) {
  const rows = timeline.rows;
  if (!rows.length) return null;
  let best = rows[0];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].t > t) break;
    best = rows[i];
  }
  return best;
}

// dis_musplus() at a given music-module-elapsed time (lower-bound model).
export function musplusAtTime(timeline, t) {
  const r = rowAtTime(timeline, t);
  if (!r) return -32;
  return musplusAt(timeline.order, r.orderIdx, r.row);
}

// First timeline row at/after fromT where predicate(musplusValue, row) holds.
export function firstTimeWhere(timeline, fromT, predicate) {
  for (const r of timeline.rows) {
    if (r.t < fromT) continue;
    const m = musplusAt(timeline.order, r.orderIdx, r.row);
    if (predicate(m, r)) return { ...r, musplus: m };
  }
  return null;
}

// U2.ASM loader gate between PANICEND and MNTSCRL: wait musplus<0, then musplus>0.
// fromT / returned times are music-module-elapsed (MUSIC1 seconds from its start).
export function loaderGateEndTime(timeline, fromT) {
  let t = fromT;
  const m0 = musplusAtTime(timeline, t);
  if (!(m0 < 0)) {
    const hit = firstTimeWhere(timeline, t, m => m < 0);
    if (!hit) return t;
    t = hit.t;
  }
  const hit2 = firstTimeWhere(timeline, t, m => m > 0);
  return hit2 ? hit2.t : t;
}
