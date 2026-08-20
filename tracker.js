// Scream Tracker 3, playing Second Reality's own two modules.
//
// The audio is rendered by libopenmpt in an AudioWorklet (the demo port's own
// engine, reused), which reports the playing order/pattern/row back on every
// audio block. The pattern view is slaved to that feed, so the highlighted row is
// the row being played rather than a re-simulation of it.
//
// s3msim.js decodes only the cells that affect tempo, because that is all the
// demo needs; a pattern display needs notes, instruments, volumes and effects, so
// there is a full S3M reader below.
//
// The .s3m files are served exactly as they ship inside REALITY.FC, still
// carrying Future Crew's copy protection. descramble() is the demo's own routine,
// the same one STARTMUS.C runs at load time.

import { descramble, buildTimeline } from '../unreal2/s3msim.js';

// --- S3M ------------------------------------------------------------------

const NOTES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

function parseS3M(buffer) {
  const d = new Uint8Array(buffer);
  const u16 = o => d[o] | (d[o + 1] << 8);
  const str = (o, n) => {
    let s = '';
    for (let i = 0; i < n && d[o + i]; i++) s += String.fromCharCode(d[o + i]);
    return s.trim();
  };
  if (str(0x2c, 4) !== 'SCRM') throw new Error('not an S3M');

  const ordNum = u16(0x20), insNum = u16(0x22), patNum = u16(0x24);
  const song = {
    title: str(0, 28), speed: d[0x31], tempo: d[0x32],
    orders: [], instruments: [], patterns: [], channels: 0,
  };
  // The whole list, including anything past the 255 "---" terminator. MUSIC0
  // has a second sequence sitting there that ordinary playback never reaches —
  // the demo jumps into it deliberately for the U2E part — and you should be
  // able to hear it, so it is playable here rather than hidden.
  for (let i = 0; i < ordNum; i++) song.orders.push(d[0x60 + i]);
  song.endMarker = song.orders.indexOf(255);

  for (let i = 0; i < insNum; i++) {
    const p = u16(0x60 + ordNum + i * 2) * 16;
    song.instruments.push(p && p + 0x50 <= d.length
      ? {
        name: str(p + 0x30, 28),
        length: d[p + 0x10] | (d[p + 0x11] << 8) | (d[p + 0x12] << 16) | (d[p + 0x13] << 24),
      }
      : { name: '', length: 0 });
  }

  let maxCh = 0;
  for (let i = 0; i < patNum; i++) {
    const p = u16(0x60 + ordNum + insNum * 2 + i * 2) * 16;
    const rows = Array.from({ length: 64 }, () => ({}));
    if (p && p + 2 <= d.length) {
      let q = p + 2, row = 0;
      const end = p + 2 + u16(p);
      while (q < end && row < 64) {
        const what = d[q++];
        if (what === 0) { row++; continue; }
        const ch = what & 31;
        if (ch > maxCh) maxCh = ch;
        const cell = {};
        if (what & 32) { cell.note = d[q++]; cell.instrument = d[q++]; }
        if (what & 64) cell.volume = d[q++];
        if (what & 128) { cell.command = d[q++]; cell.info = d[q++]; }
        rows[row][ch] = cell;
      }
    }
    song.patterns.push(rows);
  }
  song.channels = maxCh + 1;
  return song;
}

// one cell as ST3 shows it: "C-4 25 22 G00", dots where a field is empty
function cellHtml(cell) {
  const off = v => `<i class="off">${v}</i>`;
  if (!cell) return off('... .. .. ...');
  let note = '...';
  if (cell.note === 0xfe) note = '^^^';
  else if (cell.note !== undefined && cell.note !== 0xff) {
    const n = cell.note & 15;
    if (n < 12) note = NOTES[n] + (cell.note >> 4);
  }
  const ins = cell.instrument ? String(cell.instrument).padStart(2, '0') : '..';
  const vol = cell.volume !== undefined ? String(cell.volume).padStart(2, '0') : '..';
  const fx = cell.command
    ? String.fromCharCode(64 + cell.command) + (cell.info ?? 0).toString(16).toUpperCase().padStart(2, '0')
    : '...';
  const c = (v, cls) => v.startsWith('.') ? off(v) : `<i class="${cls}">${v}</i>`;
  return `${c(note, 'n')} ${c(ins, 's')} ${c(vol, 'v')} ${c(fx, 'f')}`;
}

// --- state ----------------------------------------------------------------

const TRACKS = [
  { file: '../unreal2/assets/music0.s3m', label: 'MUSIC0.S3M' },
  { file: '../unreal2/assets/music1.s3m', label: 'MUSIC1.S3M' },
];
const ROWS = 11;              // odd, current row centred — fits the 25-line screen
const CHANS = 5;              // 5 x 14 columns + the row number fits inside 80

let Player, chip = null, song = null, track = 0, bytes = null;
let playing = false, chanOff = 0, loopPattern = false;
let live = { order: 0, pattern: 0, row: 0 };
let vu = [];
let songLen = 0;          // seconds, from the s3msim timeline
let elapsed = 0, loopOrder = 0;

const $ = id => document.getElementById(id);
const clock = t => {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60), sec = Math.floor(t % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function load(i) {
  track = i;
  const raw = await fetch(TRACKS[i].file).then(r => r.arrayBuffer());
  bytes = descramble(raw);                       // copy protection, undone
  song = parseS3M(bytes);
  // exact length: walk the module the way the demo's own timeline model does
  try {
    const tl = buildTimeline(bytes.slice ? bytes.slice(0) : bytes);
    const last = tl.rows[tl.rows.length - 1];
    songLen = last ? last.t + last.speed * 2.5 / last.tempo : 0;
  } catch { songLen = 0; }
  elapsed = 0;
  vu = new Array(song.channels).fill(0);
  chanOff = 0;
  live = { order: 0, pattern: song.orders[0] ?? 0, row: 0 };
  drawOrders(); drawSamples(); draw();
}

async function play(from = null) {
  if (!Player) ({ ChiptuneJsPlayer: Player } = await import('../unreal2/vendor/chiptune3.js'));
  if (!chip) {
    chip = new Player({ repeatCount: -1 });
    await new Promise(r => chip.onInitialized(r));
    chip.onProgress(() => {
      const prevPattern = live.pattern;
      live = { order: chip.order | 0, pattern: chip.pattern | 0, row: chip.row | 0 };
      elapsed = chip.getCurrentTime() || 0;
      // F6: hold on one pattern, the way ST3's play-pattern does
      if (loopPattern && live.pattern !== prevPattern) {
        chip.setOrderRow(loopOrder, 0);
        live.pattern = prevPattern;
      }
    });
  }
  chip.play(bytes);
  if (from) chip.setOrderRow(from.order, from.row || 0);
  playing = true;
  loop();
}

function stop() { if (chip) chip.stop(); playing = false; loopPattern = false; elapsed = 0; draw(); }

// --- view -----------------------------------------------------------------

function drawSamples() {
  $('tk-smp').innerHTML = song.instruments
    .map((s, i) => ({ s, i })).filter(x => x.s.name).slice(0, 3)
    .map(({ s, i }) => `<b>${String(i + 1).padStart(2, '0')}:</b> ${esc(s.name)}`)
    .join('  ');
}

function drawOrders() {
  // Every slot, including the ones past the "---" (255) terminator. MUSIC0 has a
  // second sequence sitting back there that ordinary playback never reaches — the
  // demo jumps into it deliberately for the U2E part — so it is shown dimmed and
  // is clickable, which makes the otherwise unhearable part of the module audible.
  const out = [];
  for (let i = 0; i < song.orders.length; i++) {
    const v = song.orders[i];
    const past = song.endMarker >= 0 && i > song.endMarker;
    if (v === 255) {
      if (past) continue;                        // trailing padding, not worth showing
      out.push(`<span class="end" data-o="${i}" title="end of song">---</span>`);
      continue;
    }
    const label = v === 254 ? '+++' : String(v).padStart(2, '0');
    const cls = v === 254 ? 'mark' : (past ? 'hidden' : '');
    const tip = v === 254 ? 'sync marker' : `order ${i}${past ? ' — past the end marker' : ''}`;
    out.push(`<span class="${cls}" data-o="${i}" title="${tip}">${label}</span>`);
  }
  $('tk-ords').innerHTML = out.join(' ');
  $('tk-ords').querySelectorAll('span').forEach(s =>
    s.addEventListener('click', () => play({ order: +s.dataset.o, row: 0 })));
}

function draw() {
  if (!song) return;
  const n = Math.min(CHANS, song.channels - chanOff);
  const hex2 = v => v.toString(16).toUpperCase().padStart(2, '0');
  const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  const total = song.endMarker >= 0 ? song.endMarker : song.orders.length;

  set('f-song', song.title || '(untitled)');
  set('f-file', TRACKS[track].label);
  set('f-ord', `${String(live.order).padStart(3, '0')}/${String(total).padStart(3, '0')}`);
  set('f-pat', hex2(live.pattern));
  set('f-row', hex2(live.row));
  set('f-bpm', song.tempo);
  set('f-spd', String(song.speed).padStart(2, '0'));
  const pct = songLen ? Math.min(99, Math.floor(elapsed / songLen * 100)) : 0;
  set('f-status', playing
    ? `Playing; ord:${String(live.order).padStart(3, '0')}/${String(total).padStart(3, '0')} ` +
      `pat:${hex2(live.pattern)} row:${hex2(live.row)} played:${String(pct).padStart(2, '0')}% ` +
      `${clock(elapsed)}/${clock(songLen)}`
    : `Stopped.  ${song.channels} channels · ${song.patterns.length} patterns · ${clock(songLen)}`);

  // one row of cells per structure, so the three grids cannot drift apart
  const cells = body => `<span class="rn">00</span>` + body;
  $('tk-head').innerHTML = cells(Array.from({ length: n },
    (_, c) => `<span class="cel">${String(chanOff + c + 1).padStart(2, '0')}: CH${String(chanOff + c + 1).padStart(2, '0')}</span>`).join(''));

  const pat = song.patterns[live.pattern] || [];
  const half = (ROWS - 1) >> 1;
  const out = [];
  for (let k = -half; k <= half; k++) {
    const r = live.row + k;
    if (r < 0 || r > 63) { out.push('<div class="prow"><span class="rn"> </span></div>'); continue; }
    const row = [];
    for (let c = 0; c < n; c++) {
      const cell = pat[r] && pat[r][chanOff + c];
      if (k === 0 && playing && cell && cell.note !== undefined && cell.note < 0xfe) {
        vu[chanOff + c] = 1;
      }
      row.push(`<span class="cel">${cellHtml(cell)}</span>`);
    }
    const cls = 'prow' + (k === 0 ? ' cur' : (r & 3) === 0 ? ' beat' : '');
    out.push(`<div class="${cls}"><span class="rn">${hex2(r)}</span>${row.join('')}</div>`);
  }
  $('tk-pattern').innerHTML = out.join('');

  $('tk-vu').innerHTML = cells(Array.from({ length: n }, (_, c) => {
    const a = vu[chanOff + c] = playing ? Math.max(0, (vu[chanOff + c] || 0) - 0.07) : 0;
    const bars = Math.round(a * 8);
    return `<span class="cel"><b>${'\u2588'.repeat(bars)}</b>${'\u00b7'.repeat(8 - bars)}</span>`;
  }).join(''));

  $('tk-ords').querySelectorAll('span').forEach(s =>
    s.classList.toggle('on', +s.dataset.o === live.order));
}

let raf = 0;
function loop() { cancelAnimationFrame(raf); draw(); if (playing) raf = requestAnimationFrame(loop); }

// --- keys -----------------------------------------------------------------

export async function initTracker() {
  try { await load(0); }
  catch (e) { $('tk-meta').textContent = 'could not load: ' + e.message; return; }

  addEventListener('keydown', async e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;

    // ST3's transport keys, and space for the obvious thing
    if (k === 'F5' || k === ' ') {
      e.preventDefault();
      if (playing) stop(); else { loopPattern = false; await play(); }
    } else if (k === 'F6') {                       // play current pattern, looped
      e.preventDefault();
      loopOrder = live.order; loopPattern = true;
      await play({ order: live.order, row: 0 });
    } else if (k === 'F7') {                       // play from the current order
      e.preventDefault();
      loopPattern = false;
      await play({ order: live.order, row: 0 });
    } else if (k === 'F8') {
      e.preventDefault(); stop();
    } else if (k === '0' || k === '1') {
      e.preventDefault();
      const i = +k;
      if (i === track) return;
      const was = playing;
      await load(i);
      if (was) await play();
    } else if (k === 'ArrowRight') {
      e.preventDefault();
      chanOff = Math.min(chanOff + 1, Math.max(0, song.channels - CHANS)); draw();
    } else if (k === 'ArrowLeft') {
      e.preventDefault();
      chanOff = Math.max(0, chanOff - 1); draw();
    } else if (k === '+' || k === '=') {           // next order
      e.preventDefault();
      if (chip && playing) chip.setOrderRow(Math.min(live.order + 1, song.orders.length - 1), 0);
    } else if (k === '-') {                        // previous order
      e.preventDefault();
      if (chip && playing) chip.setOrderRow(Math.max(0, live.order - 1), 0);
    }
  });

  document.querySelectorAll('.menu a').forEach(a => a.addEventListener('click', async ev => {
    ev.preventDefault();
    const key = { 'F5': 'F5', 'F6': 'F6', 'F8': 'F8' }[a.dataset.key];
    if (key) { dispatchEvent(new KeyboardEvent('keydown', { key })); return; }
    if (a.dataset.key === '0/1') {
      const was = playing;
      await load(track === 0 ? 1 : 0);
      if (was) await play();
    }
  }));

  // Leaving the screen stops the music. An AudioWorklet does not notice that the
  // page it belongs to has been navigated away from — a standalone home-screen
  // app freezes the document rather than destroying it, and the audio thread
  // plays on. F8 is what this does anyway, so it is F8.
  addEventListener('pagehide', () => { if (playing) stop(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && playing) stop();
  });
}
