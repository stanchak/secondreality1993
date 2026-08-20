// ENDSCRL — port of the SHIPPED build (MAIN/DATA/ENDSCRL.EXE) + ASMYT.ASM.
// A 640x400, four-plane EGA ring buffer emitting one font scanline every two
// 70 Hz DIS waits.
//
// WHICH BUILD. The drop contains an EARLIER build's source:
// ENDSCRL/MAIN.C, whose own ENDSCRL/ENDSCROL.TXT is a placeholder font test
// ("And now... A font test!!!") with no directives in it at all. The demo ships
// a different, later executable plus the real 6,141-byte MAIN/DATA/ENDSCROL.TXT,
// which uses `[nn` 163 times and a `%` terminator. That executable IS part of the
// drop, so its behaviour is recoverable rather than lost: unpack it (two layers,
// PKLITE then LZEXE, e.g. `deark -m pklite` then `deark -m lzexe`) and the
// differences from MAIN.C read straight out of the 16-bit disassembly:
//
//   cmp byte [textline+0],'['   -> jne: mov word [chars],0     ; renders nothing
//   cmp byte [textline+0],'['   -> je : parse two digits and use them as the
//                                       line-height modulus instead of 25:
//        mov al,[textline+1] / add ax,-48 / imul 10
//        mov dl,[textline+2] / add ax,dx / add ax,-48 / pop bx / idiv bx
//   cmp byte [textline+0],'%'   -> push 0 / call exit          ; ends the part
//   default line-height modulus is 25 (`mov bx,0x19`), not MAIN.C's FONAY 30
//   fonaorder gains  Z ä ö Y / &  after the "()+-*='" run
//
// So `[nn` is a BLANK GAP nn scanlines tall, and `%` is the end of the scroller.
// Rendering `[nn` as the literal text "15"/"12" (what MAIN.C's parser does, since
// '[' is absent from its fonaorder and so has width 0) is what the user saw.
//
// Two consequences worth noting. The shipped fonaorder matters a lot: on the real
// text the dev order leaves `/`x83, `&`x26, `Z`x12, `ä`x2 and `Y`x1 with width 0,
// i.e. 124 invisible characters, and maps `"` onto Z's glyph. And the 25-row line
// height clips nothing — the FONA's glyphs occupy rows 0..17 and rows 18..29 are
// blank padding — it just tightens the spacing.
//
// The single-digit form is an ORIGINAL BUG, reproduced here: the parser always
// reads two digits, so `[8` takes textline[2] = the CR of the CRLF, giving
// 8*10 + 13 - 48 = 45 scanlines rather than 8. Harmless, because chars=0 means
// the font is never indexed at those rows.

const VBLANK_HZ = 70;
const WIDTH = 640;
const HEIGHT = 400;
const RING_ROWS = 802; // rows y and y+401 both fit in the EGA 64 KiB planes
const FONT_ROWS = 30;         // the FONA asset's height
const LINE_H = 25;            // shipped build's default line-height modulus
const FONT_STRIDE = 1500;

export const endscrlVram = new Uint8Array(WIDTH * HEIGHT);
export const endscrlPal = new Uint8Array(768);

let font = null;
let text = null;
const fontPos = new Int32Array(256);
const fontWidth = new Int32Array(256);
const ring = new Uint8Array(WIDTH * RING_ROWS);
let textPtr = 0;
let textLine = new Uint8Array(0);
let lineWidth = 0;
let lineChars = 0;
let fontLine = 0;
let lineHeight = LINE_H;
let terminated = false;
let yScroll = 0;
let localFrame = 0;
let waitPhase = 0;

function fontOrderBytes() {
  const ascii = s => [...s].map(ch => ch.charCodeAt(0));
  return Uint8Array.from([
    ...ascii('ABCDEFGHIJKLMNOPQRSTUVWXabcdefghijklmnopqrstuvwxyz0123456789!?,.:'),
    0x8f, 0x8f,
    ...ascii('()+-*=\''),
    // the shipped build's additions — without these, 124 characters of the real
    // credit text render with width 0 (invisible)
    ...ascii('Z'), 0x84, 0x94, ...ascii('Y/&'),
  ]);
}

function buildFontMetrics() {
  let x = 0;
  for (const code of fontOrderBytes()) {
    while (x < FONT_STRIDE) {
      let y = 0;
      while (y < FONT_ROWS && font[y * FONT_STRIDE + x] === 0) y++;
      if (y !== FONT_ROWS) break;
      x++;
    }
    const start = x;
    while (x < FONT_STRIDE) {
      let y = 0;
      while (y < FONT_ROWS && font[y * FONT_STRIDE + x] === 0) y++;
      if (y === FONT_ROWS) break;
      x++;
    }
    fontPos[code] = start;
    fontWidth[code] = x - start;
  }
  fontPos[32] = FONT_STRIDE - 20;
  fontWidth[32] = 16;
}

export async function loadEndscrl() {
  const [fontBytes, textBytes] = await Promise.all([
    fetch('assets/endscrl_fona.bin').then(r => r.arrayBuffer()),
    fetch('assets/endscrol.txt').then(r => r.arrayBuffer()),
  ]);
  font = new Uint8Array(fontBytes);
  text = new Uint8Array(textBytes);
  if (font.length !== FONT_ROWS * FONT_STRIDE) throw new Error('ENDSCRL FONA size');
  buildFontMetrics();
  endscrlPal.fill(0);
  for (let i = 1; i < 16; i++) {
    const level = i === 1 ? 20 : i === 2 ? 40 : 60;
    endscrlPal.fill(level, i * 3, i * 3 + 3);
  }
  console.log('[ENDSCRL] exact 640x400 EGA/FONA scroller loaded');
}

function beginTextLine() {
  if (textPtr >= text.length) {
    textLine = new Uint8Array(0);
    lineChars = 0;
    lineWidth = 0;
    return;
  }
  const start = textPtr;
  while (textPtr < text.length && text[textPtr] !== 10) textPtr++;
  textLine = text.slice(start, textPtr);
  if (textPtr < text.length) textPtr++;
  lineChars = textLine.length;
  let width = 0;
  for (const code of textLine) width += fontWidth[code] + 2;
  lineWidth = Math.trunc((639 - width) / 2);
  // shipped-build directives, keyed on the FIRST character of the line
  lineHeight = LINE_H;
  if (textLine[0] === 0x5b) {            // '[' — blank gap of nn scanlines
    lineChars = 0;                       // mov word [chars],0
    const d1 = textLine.length > 1 ? textLine[1] : 48;
    const d2 = textLine.length > 2 ? textLine[2] : 48;
    lineHeight = (d1 - 48) * 10 + d2 - 48;   // two-digit parse, CR quirk intact
    if (lineHeight < 1) lineHeight = 1;
  } else if (textLine[0] === 0x25) {     // '%' — exit(0)
    lineChars = 0;
    terminated = true;
  }
}

function renderScanline() {
  if (fontLine === 0) beginTextLine();
  const scan = new Uint8Array(WIDTH);
  let x = lineWidth;
  for (let i = 0; i < lineChars; i++, x += 2) {
    const code = textLine[i];
    const source = fontPos[code];
    const width = fontWidth[code];
    for (let b = 0; b < width; b++, x++) {
      if (x >= 0 && x < WIDTH) scan[x] ^= font[fontLine * FONT_STRIDE + source + b] & 15;
    }
  }
  ring.set(scan, yScroll * WIDTH);
  ring.set(scan, (yScroll + 401) * WIDTH);
  yScroll = (yScroll + 1) % 401;
  fontLine = (fontLine + 1) % lineHeight;
}

function presentRing() {
  const start = yScroll + 1; // setstart(yscrl*80 + 80)
  for (let y = 0; y < HEIGHT; y++)
    endscrlVram.set(ring.subarray((start + y) * WIDTH, (start + y + 1) * WIDTH), y * WIDTH);
}

export function endscrlReset() {
  textPtr = 0;
  textLine = new Uint8Array(0);
  lineWidth = 0;
  lineChars = 0;
  fontLine = 0;
  lineHeight = LINE_H;
  terminated = false;
  yScroll = 0;
  localFrame = 0;
  waitPhase = -1; // one setup wait, then two waits per do_scroll()
  ring.fill(0);
  endscrlVram.fill(0);
}

// The shipped build ends itself: a line beginning '%' calls exit(0). MAIN/DATA/
// ENDSCROL.TXT has exactly one, at line 537, after 11,500 scanlines of text and
// gaps = 328.6 s at one scanline per two vblanks. (The dev MAIN.C has no such
// check and just runs `while(!dis_exit())` forever.)
export function endscrlEnded() { return terminated; }
export function endscrlLocalFrames() { return localFrame; }
export function endscrlDurationS() { return terminated ? localFrame / VBLANK_HZ : null; }

export function endscrlStepTo(seconds, replay) {
  const target = Math.floor(seconds * VBLANK_HZ);
  let steps = target - localFrame;
  if (steps <= 0) return true;
  if (steps > 35 && !replay) steps = 35;
  for (let s = 0; s < steps && !terminated; s++) {
    localFrame++;
    if (waitPhase < 0) { waitPhase = 0; continue; }
    waitPhase++;
    if (waitPhase === 2) {
      renderScanline();
      waitPhase = 0;
    }
  }
  presentRing();
  return true;
}
