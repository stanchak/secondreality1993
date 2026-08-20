// Second Reality — PAM ("Alkutekstit III", the moon explosion) + BEG (logo).
// PAM plays PRAX4.FLI: the moon rises over the panorama, ignites, and explodes
// into an expanding debris ring that whites out the screen; BEG then fades the
// SECOND REALITY title painting in from white. Both assets ship VERBATIM from
// the source tree and are decoded here in the browser:
//   - PRAX4.FLI  : Autodesk Animator FLI (decoder ported from PAM/VFLI.C)
//   - SRTITLE.UP : FC's packed picture format (decoder ported from BEG/READP.C)
//
// Original source is public domain (Unlicense, 2013 anniversary release).

export let pamFrames = null;   // Array<Uint8Array(64000)> — decoded FLI frames
export let pamPal = null;      // Uint8Array(768) 6-bit (the FLI's only palette)
export let logoPix = null;     // Uint8Array(320*400) — SRTITLE picture
export let logoPal = null;     // Uint8Array(768) 6-bit

export async function loadPam() {
  const [fRes, sRes] = await Promise.all([
    fetch('assets/prax4.fli'), fetch('assets/srtitle.up')]);
  decodeFLI(new Uint8Array(await fRes.arrayBuffer()));
  decodeUP(new Uint8Array(await sRes.arrayBuffer()));
}

// --- FLI decoder (port of PAM/VFLI.C doblock/readflic) -----------------------
function decodeFLI(d) {
  const rd16 = o => d[o] | (d[o + 1] << 8);
  const rd32 = o => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
  const vram = new Uint8Array(64000);
  const pal = new Uint8Array(768);
  pamFrames = [];
  console.groupCollapsed(
    '%c[PAM] decoding PRAX4.FLI — the moon explosion, shipped verbatim',
    'color:#ffe14d');
  console.log(`FLI header: ${rd16(6)} frames, ${rd16(8)}x${rd16(10)}, speed ${rd16(16)}`);
  let p = 0x80;
  while (p < d.length - 6) {
    const flen = rd32(p), ftype = rd16(p + 4);
    if (ftype === 0xf1fa) {                      // frame header
      const chunks = rd16(p + 6);
      let q = p + 16;
      for (let c = 0; c < chunks; c++) {
        const clen = rd32(q), ctype = rd16(q + 4), body = q + 6;
        if (ctype === 0x0b || ctype === 0x04) {  // palette (6-bit / 8-bit)
          let b = body + 2, idx = 0;
          for (let pk = rd16(body); pk > 0; pk--) {
            idx += d[b]; const cnt = d[b + 1] || 256; b += 2;
            for (let k = 0; k < cnt * 3; k++)
              pal[idx * 3 + k] = ctype === 0x0b ? d[b + k] : d[b + k] >> 2;
            b += cnt * 3; idx += cnt;
          }
        } else if (ctype === 0x0c) {             // FLI_LC: delta lines
          const lb = rd16(body), ln = rd16(body + 2);
          let b = body + 4;
          for (let lc = lb; lc < lb + ln; lc++) {
            let u = lc * 320;
            for (let cm = d[b++]; cm > 0; cm--) {
              u += d[b]; let a = d[b + 1]; b += 2;
              if (a < 0x80) { vram.set(d.subarray(b, b + a), u); u += a; b += a; }
              else { a = 256 - a; vram.fill(d[b], u, u + a); u += a; b++; }
            }
          }
        } else if (ctype === 0x0f) {             // FLI_BRUN: full-frame RLE
          let b = body;
          for (let lc = 0; lc < 200; lc++) {
            let u = lc * 320;
            for (let cm = d[b++]; cm > 0; cm--) {
              let a = d[b++];
              if (a < 0x80) { vram.fill(d[b], u, u + a); u += a; b++; }
              else { a = 256 - a; vram.set(d.subarray(b, b + a), u); u += a; b += a; }
            }
          }
        } else if (ctype === 0x10) {             // FLI_COPY
          vram.set(d.subarray(body, body + 64000));
        } else console.warn(`unknown FLI chunk 0x${ctype.toString(16)}`);
        q += clen;
      }
      pamFrames.push(vram.slice());
    }
    p += flen || 6;
  }
  pamPal = pal;
  console.log(`decoded ${pamFrames.length} frames of 320x200 (moon -> boom -> whiteout)`);
  console.groupEnd();
}

// --- SRTITLE.UP decoder (port of BEG/READP.C) --------------------------------
// header: int16 magic,wid,hig,cols,add; palette at +16 (cols*3, 6-bit);
// row records at add*16: {int16 len; RLE data} per row — tag byte >= 0x80 is a
// run of (tag&0x7f) copies of the next byte, tag < 0x80 is that literal byte.
// READP.C's run loop is a do-while (`l4: store; dec ah; jnz l4`), so a tag byte
// of exactly 0x80 — count field 0 — stores once, wraps ah to 0xff and runs 255
// more: a run of 256, not of 0. No shipped picture happens to use 0x80, so this
// was latent, but a zero-length run would silently short the row.
function decodeUP(d) {
  const rd16 = o => d[o] | (d[o + 1] << 8);
  const wid = rd16(2), hig = rd16(4), cols = rd16(6), add = rd16(8);
  logoPal = new Uint8Array(768);
  logoPal.set(d.subarray(16, 16 + cols * 3));
  logoPix = new Uint8Array(wid * hig);
  let p = add * 16;
  for (let y = 0; y < hig; y++) {
    const bytes = rd16(p); p += 2;
    const end = p + bytes;
    let u = y * wid;
    while (p < end) {
      const a = d[p++];
      if (a >= 0x80) { const n = (a & 0x7f) || 256; logoPix.fill(d[p++], u, u + n); u += n; }
      else logoPix[u++] = a;
    }
    p = end;
  }
  console.log(`[BEG] SRTITLE.UP: ${wid}x${hig}, ${cols} colors — the title painting`);
}
