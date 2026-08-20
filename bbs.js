// Shared BBS chrome: the top bar, the rules, and the command line at the bottom.
//
// The command line is real. Single keys work as menu hotkeys the way WWIV did,
// but you can also type a command and press Enter — which is what the prompt
// looked like it was inviting all along.

const NODE = 1;

// Every screen on the board. `key` is the hotkey shown in the menu.
export const PAGES = [
  { key: '1', file: '?play',        title: 'Run the demo',        desc: 'fullscreen, volume up' },
  { key: 'J', file: 'parts.html',   title: 'Jump to a part',      desc: 'every part, and who wrote it' },
  { key: '2', file: 'tracker.html', title: 'Play the music',      desc: 'the demo’s own modules, playing' },
  { key: '3', file: 'about.html',   title: 'What this is',        desc: 'the port, in brief' },
  { key: '4', file: 'crew.html',    title: 'Future Crew',         desc: 'who they were, where they went' },
  { key: '5', file: 'legacy.html',  title: 'Why it mattered',     desc: 'Assembly ’93 and after' },
  { key: '6', file: 'scream.html',  title: 'Scream Tracker',      desc: 'the tracker and the S3M format' },
  { key: '7', file: 'tech.html',    title: 'How the port works',  desc: 'technical' },
  { key: '8', file: 'gallery.html', title: 'Gallery',             desc: 'artwork from the release' },
  { key: '9', file: 'credits.html', title: 'Credits',             desc: 'who made this' },
  { key: 'L', file: 'license.html', title: 'Licence',             desc: 'public domain' },
];

// Esc walks UP this tree rather than back through history, so it behaves the
// same from wherever you are and always terminates at the main menu. Anything
// not listed here goes straight home.
const PARENT = {
  'crew-now.html':    'crew.html',
  'crew-pixel.html':  'crew-now.html',
  'crew-then.html':   'crew-now.html',
  'legacy-asm.html':  'legacy.html',
  'tech-music.html':  'tech.html',
  'tech-timing.html': 'tech.html',
  'tech-vga.html':    'tech.html',
  'tech-assets.html': 'tech.html',
  'tech-size.html':   'tech.html',
  'tech-js.html':     'tech-size.html',
  'tech-verify.html': 'tech.html',
  'hidden.html':      'help.html',
  'hw.html':          'hidden.html',
  'dolby.html':       'hidden.html',
  'starport.html':    'hidden.html',
  'hidden-part.html': 'hidden.html',
  'hidden-how.html':  'hidden-part.html',
  'pixel.html':       'hidden.html',
  'sysop.html':       'hidden.html',
  'bye.html':         'hidden.html',
};

// Screen titles, for the "ESC goes here" hint. PAGES supplies most of them.
const TITLES = {
  'index.html': 'Main Menu', 'help.html': 'Help', 'hidden.html': 'Hidden screens',
  'crew-now.html': 'Where they are now', 'crew-pixel.html': 'Pixel',
  'crew-then.html': 'They founded Remedy', 'legacy-asm.html': 'Assembly ’94',
  'tech.html': 'Technical',
};
for (const p of PAGES) TITLES[p.file] ??= p.title;

// Typed commands. Keys are what you type; values are where you land.
const COMMANDS = {
  main: '/', menu: '/', home: '/', g: '/',
  about: 'about.html', crew: 'crew.html', fc: 'crew.html',
  now: 'crew-now.html', misko: 'crew-pixel.html', skaven: 'crew-then.html',
  remedy: 'crew-then.html', gore: 'crew-then.html',
  legacy: 'legacy.html', why: 'legacy.html',
  assembly: 'legacy-asm.html', asm: 'legacy-asm.html', asm94: 'legacy-asm.html',
  scream: 'scream.html', st3: 'scream.html', s3m: 'scream.html',
  tracker: 'tracker.html', music: 'tracker.html', play: 'tracker.html',
  tech: 'tech.html', how: 'tech.html',
  size: 'tech-size.html', bytes: 'tech-size.html',
  gallery: 'gallery.html', art: 'gallery.html', pics: 'gallery.html',
  demo: '?play', run: '?play', u2: '?play',
  parts: 'parts.html', jump: 'parts.html', chain: 'parts.html',
  full: 'unreal2/', fullscreen: 'unreal2/',
  credits: 'credits.html', license: 'license.html', licence: 'license.html',
  help: 'help.html',
  // not on any menu — listed on the hidden screen, which ? links to
  hidden: 'hidden.html', eggs: 'hidden.html',
  pixel: 'pixel.html', pxl: 'pixel.html', sux: 'pixel.html',
  sysop: 'sysop.html', system: 'sysop.html', stats: 'sysop.html',
  u: 'hidden-part.html', ddstars: 'hidden-part.html',
  hw: 'hw.html', '386': 'hw.html', setup: 'hw.html',
  dolby: 'dolby.html', surround: 'dolby.html',
  starport: 'starport.html', bbs: 'starport.html', mail: 'starport.html',
  bye: 'bye.html', logoff: 'bye.html', off: 'bye.html', goodbye: 'bye.html',
};

// Commands that do something rather than go somewhere.
const ACTIONS = {
  rescan: () => { clearSeen(); location.href = '/'; },
  unread: () => { clearSeen(); location.href = '/'; },
  new: () => { location.href = firstUnread(); },
};

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const rule = ch => `<div class="rule">${ch.repeat(80)}</div>`;
const here = () => location.pathname.split('/').pop() || 'index.html';

// ---------------------------------------------------------------------------
// The demo screen, built in place.
//
// A demo should open at full screen, and the only way to get there is to NOT
// navigate. Fullscreen can only be requested from inside a user gesture, in the
// same document that goes fullscreen, and a page load throws that away: after
// navigating, Chromium answers the request with "API can only be initiated by a
// user gesture" (activation isActive=false, and any fullscreen entered before
// the navigation has already been dropped). So picking [1] does not navigate
// — it builds the demo screen right here, inside the keystroke.

const DEMO_SRC = 'unreal2/';
const DEMO_MENU = [
  { key: 'J', file: 'parts.html', title: 'Jump to a part',      desc: 'every part, by name — or press J' },
  { key: 'F', file: DEMO_SRC,     title: 'Open in full window', desc: 'without the board around it' },
];
// The demo owns the keyboard while it has focus — its own transport is on
// space, the arrows and 1-9, and Q inside it comes back to the board.
const DEMO_KEYS = [' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
                   '1', '2', '3', '4', '5', '6', '7', '8', '9'];

// A phone, or anything else driven by a fingertip. Used to decide presentation,
// never to decide what the demo does.
const TOUCH = matchMedia('(pointer: coarse)').matches;
const portrait = () => matchMedia('(orientation: portrait)').matches;
// Installed to the home screen, where the browser's own bars are gone. iOS
// reports it on navigator, everyone else through the display-mode query.
const STANDALONE = navigator.standalone === true ||
  matchMedia('(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)').matches;

// Open the demo the way a video opens: full screen, and landscape whether or not
// the phone is being held that way.
//
// Android gives us both halves — element fullscreen, then an orientation lock,
// which is only allowed once something IS fullscreen. iOS gives us neither to
// anything that is not a <video>, so the fallback is the one every video site
// ends up writing: keep the page as it is and turn the frame a quarter turn, so
// a portrait phone shows a landscape demo across the glass.
// Note which element goes fullscreen: the WRAPPER, not the <iframe> inside it.
// A fullscreen element cannot be transformed — Chromium's UA stylesheet pins
// `transform: none !important` on :fullscreen — so rotating the frame only works
// if the frame is not itself the thing in the top layer.
function goFullscreen(host, f) {
  const enter = host.requestFullscreen || host.webkitRequestFullscreen;
  const done = enter ? Promise.resolve(enter.call(host)).catch(() => {}) : Promise.resolve();
  if (!TOUCH) return;

  document.body.classList.add('demo-fs');
  // Track the physical orientation for as long as the demo is up: the rotation
  // is only wanted while the phone is actually portrait. If it is turned, the
  // real landscape takes over and the quarter turn has to come off.
  const syncRotation = () => {
    document.body.classList.toggle('demo-rot',
      document.body.classList.contains('demo-fs') && portrait());
  };
  // Whether we end up landscape is the only thing that matters, and lock() is a
  // poor witness to it: iOS does not implement it, and where it does exist it
  // resolves happily without turning anything — on a desktop, or on a phone
  // whose owner has rotation locked in Control Centre. So ask for the lock, then
  // look at what actually happened and turn the frame ourselves if nothing did.
  if (typeof screen.orientation?.lock !== 'function') {
    syncRotation();                                  // nothing here is going to rotate
  } else {
    done.then(() => screen.orientation.lock('landscape'))
        .then(() => setTimeout(syncRotation, 300),   // give a real rotation time to land
              () => syncRotation());                 // refused outright
  }
  addEventListener('orientationchange', syncRotation);
  matchMedia('(orientation: portrait)').addEventListener?.('change', syncRotation);
}

// Undo all of it: the class, the quarter turn, and the orientation lock.
function releaseFullscreen() {
  document.body.classList.remove('demo-fs', 'demo-rot');
  try { screen.orientation?.unlock?.(); } catch { /* never locked */ }
}

// '' to play from the top. Also accepts leftover demo.html#glenz links.
function demoSlug(url) {
  const s = String(url).trim();
  if (/^(?:\?play|\/\?play|index\.html\?play)$/i.test(s)) return '';
  let m = /(?:\?|&)part=([A-Za-z0-9]+)/.exec(s);
  if (m) return m[1].toLowerCase();
  m = /^(?:\.\/)?demo\.html(?:#([A-Za-z0-9]*))?$/.exec(s);
  return m ? (m[1] || '').toLowerCase() : null;
}

// Which screen the DOM is actually showing. It only differs from the URL while
// the demo is mounted into some other page's document, and history traversal is
// what has to be reconciled against it.
let shownPage = here();

export function mountDemo({ want = '', fullscreen = false } = {}) {
  const crt = document.querySelector('.crt');
  if (!crt) { location.href = want ? '/?part=' + encodeURIComponent(want) : '/'; return null; }

  // Rebuild the screen from scratch so every way in looks the same.
  // The stage sits between the fullscreen wrapper and the frame so that the
  // quarter turn has something to act on which is not the fullscreen element —
  // and so anything laid over the demo turns with it and stays readable.
  crt.innerHTML =
    `<div class="body demo"><div class="stage">` +
    `<iframe id="demo" title="Second Reality, running" ` +
    `allowfullscreen allow="autoplay; fullscreen"></iframe>` +
    `</div></div>` +
    `<div class="menu" id="m">${menu(DEMO_MENU)}</div>`;
  const f = document.getElementById('demo');
  const host = crt.querySelector('.body.demo');
  const stage = crt.querySelector('.stage');

  // Spend the gesture first. Everything below is bookkeeping, and the activation
  // is gone the moment this handler returns.
  if (fullscreen) goFullscreen(host, f);

  // On iPhone Safari nothing that is not a <video> can have the screen, so the
  // bars stay and the demo runs under them. Installing the board is the only way
  // out of that, and it is one the visitor has to be told about — once, in the
  // stage's own coordinates so it reads the same way round as the demo.
  if (fullscreen && TOUCH && !document.fullscreenEnabled && !STANDALONE) {
    const hint = document.createElement('div');
    hint.className = 'fs-hint';
    hint.innerHTML = 'Safari keeps its bars. <b>Share ↑ &rsaquo; Add to Home Screen</b>' +
                     ' runs this with the whole screen.<span class="x">✕</span>';
    stage.appendChild(hint);
    const drop = () => hint.remove();
    hint.addEventListener('click', drop);
    setTimeout(drop, 9000);
  }

  f.src = DEMO_SRC + (want ? '?part=' + encodeURIComponent(want) : '');

  // main.js decides its own letterboxing from document.fullscreenElement, which
  // stays null in a child whose PARENT fullscreened the <iframe> — the child
  // sees no fullscreen element even though it now owns the whole display. So
  // say so directly, on entry and on exit.
  // Escape is taken by the browser to leave fullscreen, so the demo never sees
  // the key — and its own Escape leaves the demo (main.js), which is what it
  // should still mean here rather than dropping you into the board mid-part. So
  // leaving fullscreen leaves the demo, unless ⛶ asked for a window rather than
  // an exit.
  let wasFs = false, toWindow = false;
  const tellFs = () => {
    // Owning the whole screen counts whether the browser granted it or the
    // stylesheet did — on iOS the second is the only one on offer, and the demo
    // has to letterbox for the screen either way.
    const on = (document.fullscreenElement || document.webkitFullscreenElement) === host
      || document.body.classList.contains('demo-fs');
    if (wasFs && !on && !toWindow) { releaseFullscreen(); stopDemoFrame(); location.href = '/'; return; }
    wasFs = on; toWindow = false;
    try { f.contentWindow.postMessage({ sr: 'fs', on, touch: TOUCH }, location.origin); }
    catch { /* not up yet; the load handler repeats it */ }
  };
  document.addEventListener('fullscreenchange', tellFs);
  document.addEventListener('webkitfullscreenchange', tellFs);
  f.addEventListener('load', () => { tellFs(); try { f.contentWindow.focus(); } catch {} });

  // The demo reports which part it is on. Show it where a board showed the node
  // and the baud rate, and keep the address bar pointed at the current part so
  // the URL stays worth copying at any moment.
  // Until the demo actually reaches the part that was asked for, leave the URL
  // alone — if autoplay is refused the demo sits on its first frame waiting for
  // a keypress, and rewriting the hash then would throw away the part the
  // visitor came here for.
  let tracking = !want;
  const mmss = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  addEventListener('message', e => {
    if (e.origin !== location.origin) return;
    // its ⛶ cannot leave a fullscreen it did not enter, so it asks. On a desktop
    // that means "give me a window"; the ✕ a phone shows instead means "I am
    // done", and on a phone there is no useful window to be given anyway.
    if (e.data?.sr === 'fsexit') {
      const leaving = !!e.data.leave;
      toWindow = !leaving;
      releaseFullscreen();
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
      if (leaving) { stopDemoFrame(); location.href = '/'; }
      return;
    }
    if (e.data?.sr !== 'part') return;
    const { label, index, count, slug, t, paused } = e.data;
    // count 1 is the hidden part, which is not one of nineteen anything.
    const which = count > 1 ? `PART ${String(index + 1).padStart(2, '0')}/${count} · ` : '';
    setStatus(`${which}${label} · ` + (paused ? 'PAUSED' : mmss(t)));
    if (slug === want) tracking = true;
    if (tracking && slug && location.hash.slice(1) !== slug) {
      history.replaceState(null, '', '#' + slug);
    }
  });

  // Stay put. The demo is something the menu does, not a page.
  shownPage = here();

  chrome({ title: 'The demo', prompt: 'Key', reserve: DEMO_KEYS });
  return f;
}

// "You are caller #N" — every board had one, and it is the one number on a BBS
// that was always honest about being local.
function callerNumber() {
  try {
    const n = (Number(localStorage.getItem('sr-caller')) || 0) + 1;
    localStorage.setItem('sr-caller', String(n));
    return n;
  } catch { return 1; }
}

// ---------------------------------------------------------------------------
// Read / unread. A board told you what was new since your last call; with two
// dozen screens here that is the same problem, so it gets the same answer — a
// '*' in the left margin of any menu entry you have not opened yet.

const SEEN = 'sr-seen';
function seenSet() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN) || '[]')); }
  catch { return new Set(); }
}
function markSeen(file) {
  try {
    const s = seenSet();
    if (s.has(file)) return;
    s.add(file);
    localStorage.setItem(SEEN, JSON.stringify([...s]));
  } catch { /* private mode — the marks just do not persist */ }
}
function clearSeen() { try { localStorage.removeItem(SEEN); } catch {} }

// Time on system, stamped once per browser session so the logoff screen can
// report it the way a board did.
function stampLogin() {
  try { sessionStorage.getItem('sr-login') || sessionStorage.setItem('sr-login', String(Date.now())); }
  catch {}
}
export function session() {
  let caller = 1, login = Date.now();
  try {
    caller = Number(localStorage.getItem('sr-caller')) || 1;
    login = Number(sessionStorage.getItem('sr-login')) || login;
  } catch {}
  return { caller, minutes: Math.max(1, Math.round((Date.now() - login) / 60000)) };
}
function firstUnread() {
  const s = seenSet();
  const p = PAGES.find(p => !s.has(p.file));
  return p ? p.file : 'index.html';
}

// ---------------------------------------------------------------------------

// `reserve` lets a page claim keys for itself — the tracker owns 0/1/space and
// the arrows, and without this the board's hotkeys would fire first.
export function chrome({ title, prompt = 'Command', back = true, reserve = [] } = {}) {
  const now = new Date();
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const crt = document.querySelector('.crt');
  if (!crt) return;

  const caller = here() === 'index.html' ? ` · CALLER #${callerNumber()}` : '';
  crt.insertAdjacentHTML('afterbegin',
    `<div class="topbar"><span>SECOND REALITY · ${title}</span>` +
    `<span class="r" id="topbar-r">NODE ${NODE} · 2400 BAUD${caller} · ${clock}</span></div>` +
    rule('═'));

  // Say where ESC actually goes — the tree is hierarchical, so "back" is not
  // always the main menu and there is no reason to make anyone guess.
  const up = PARENT[here()] || 'index.html';

  if (TOUCH) {
    // A command prompt with a blinking caret is a promise of a keyboard, and a
    // phone has not got one until something asks for it. What a phone actually
    // lacks is ESC: the board's tree is walked with a key that does not exist
    // here, so the bottom line becomes the thing that walks it — a real button,
    // saying where it goes, the way the hint used to.
    const bar = back
      ? `<a class="tb" href="${up}">◀ ${TITLES[up] || 'Main Menu'}</a>`
      : `<span class="tb off">tap a line to open it</span>`;
    crt.insertAdjacentHTML('beforeend',
      rule('─') +
      `<div class="cmd touch">${bar}<a class="tb" href="help.html">? help</a></div>`);
  } else {
    const hint = back ? `ESC ‹ ${TITLES[up] || 'Main Menu'} · / command · TAB completes · ? help`
                      : '↑↓ select · / command · ? help';
    crt.insertAdjacentHTML('beforeend',
      rule('─') +
      `<div class="cmd"><span class="yel">${prompt}</span>` +
      `<span class="dim" id="cmd-hint"> [${hint}]</span>` +
      `<span class="wht"> → </span><span id="cmd-buf" class="wht"></span>` +
      `<span class="cursor"></span></div>`);
  }

  wireKeys({ back, reserve });
  wireBoard();
  markSeen(here());
  stampLogin();
}

let boardWired = false;
function wireBoard() {
  if (boardWired) return;
  boardWired = true;

  addEventListener('popstate', () => { if (here() !== shownPage) location.reload(); });

  // Belt and braces on the demo's own pagehide handler: kill the frame on the way
  // out rather than trusting it to notice it is leaving. An <iframe> that loses
  // its src loses its document, and with it the AudioContext — and this runs
  // before the navigation, not during the unload, which is the difference between
  // reliable and hopeful on the browser where this went wrong.
  addEventListener('pagehide', stopDemoFrame);

  // Every link to the demo — the main menu's [1], every row of the parts index —
  // mounts it here instead of navigating, because the click is the only user
  // gesture we get and a navigation would spend it (see mountDemo). Capturing,
  // so it runs before anything else can follow the href.
  addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;   // open-in-new-tab etc.
    const a = e.target.closest?.('a[href]');
    if (!a || a.target) return;
    const want = demoSlug(a.getAttribute('href'));
    if (want === null) {
      // some other link: if the demo is up, this is a way out of it
      if (a.getAttribute('href') !== '#') stopDemoFrame();
      return;
    }
    e.preventDefault();
    mountDemo({ want, fullscreen: true });
  }, true);
}

// Take the demo's document away, which takes its audio with it. Safe to call
// when there is no demo mounted.
function stopDemoFrame() {
  const f = document.getElementById('demo');
  if (f && f.getAttribute('src') !== 'about:blank') f.src = 'about:blank';
}

// ---------------------------------------------------------------------------

// A leading '*' marks a screen you have not opened. Its column is always there
// so nothing shifts when a mark clears.
export function menu(items) {
  const width = 34;
  const s = seenSet();
  return `<div class="menu">` + items.map(p => {
    const tracked = /\.html$/.test(p.file) && p.file !== here();
    const mark = tracked && !s.has(p.file) ? '<span class="grn">*</span>' : ' ';
    // The dot leaders are their own span so a narrow screen can drop them and
    // put the description on its own line instead of ellipsising the row.
    return `<a href="${p.file}" data-key="${p.key}" tabindex="0">` +
      `${mark}<span class="k">[${p.key}]</span> <span class="t">${pad(p.title, 22)}</span>` +
      `<span class="dots">${'.'.repeat(Math.max(2, width - p.title.length))} </span>` +
      `<span class="d">${p.desc}</span></a>`;
  }).join('') + `</div>`;
}

// ---------------------------------------------------------------------------

let keyHandler = null, pageHandler = null;

function wireKeys({ back, reserve = [] }) {
  const owned = new Set(reserve.map(k => k.toLowerCase()));
  const links = [...document.querySelectorAll('.menu a')];
  const buf = document.getElementById('cmd-buf');
  const hintEl = document.getElementById('cmd-hint');
  const hintText = hintEl?.innerHTML ?? '';
  let typed = '';
  let typing = false;
  let sel = -1;

  const WORDS = [...Object.keys(COMMANDS), ...Object.keys(ACTIONS)].sort();
  const matches = s => (s ? WORDS.filter(w => w.startsWith(s)) : WORDS);

  // While typing, the static hint's space is better spent on what completes.
  const show = () => {
    if (buf) { buf.textContent = typing ? '/' + typed : ''; buf.className = 'wht'; }
    if (!hintEl) return;
    if (!typing) { hintEl.innerHTML = hintText; return; }
    const m = matches(typed);
    const list = m.slice(0, 6).join(' ') + (m.length > 6 ? ` +${m.length - 6}` : '');
    hintEl.innerHTML = ` [${m.length ? list : 'no such command'}]`;
  };
  const select = (i, scroll = true) => {
    if (!links.length) return;
    sel = (i + links.length) % links.length;
    links.forEach((a, n) => a.classList.toggle('sel', n === sel));
    if (scroll) links[sel].scrollIntoView({ block: 'nearest' });
  };
  // Typed commands (/demo, /run, /u2) and hotkeys land here too, and they are
  // just as much a gesture as a click — so they get the demo in place as well.
  const go = url => {
    const want = demoSlug(url);
    if (want !== null) { mountDemo({ want, fullscreen: true }); return; }
    stopDemoFrame();               // leaving a mounted demo by key or command
    location.href = url;
  };

  const escape = () => {
    const p = here();
    if (p === 'index.html' || p === '') return;          // already home
    go(PARENT[p] || '/');
  };

  const reject = cmd => {
    if (!buf) return;
    buf.textContent = '/' + cmd + ' ?';
    buf.className = 'red';
    setTimeout(() => {
      if (typing) return;                                // they started again
      buf.textContent = ''; buf.className = 'wht';
    }, 900);
  };

  // Exact match, then a unique prefix, then a unique substring. Typing /lic and
  // getting the licence is the behaviour a forgiving board had; typing /t and
  // getting one of six things at random is not, so ambiguity is an error.
  const resolve = cmd => {
    if (COMMANDS[cmd]) return () => go(COMMANDS[cmd]);
    if (ACTIONS[cmd]) return ACTIONS[cmd];
    const page = PAGES.find(p => p.key.toLowerCase() === cmd);
    if (page) return () => go(page.file);
    const local = links.find(a => a.dataset.key?.toLowerCase() === cmd);
    if (local) return () => local.click();
    for (const test of [w => w.startsWith(cmd), w => w.includes(cmd)]) {
      const hits = WORDS.filter(test);
      if (!hits.length) continue;
      // Several words can be one destination — /lic matches both spellings of
      // the licence — so what has to be unambiguous is where you end up, not
      // which synonym you happened to abbreviate.
      if (new Set(hits.map(w => COMMANDS[w] || w)).size !== 1) continue;
      const w = hits[0];
      return COMMANDS[w] ? () => go(COMMANDS[w]) : ACTIONS[w];
    }
    return null;
  };

  const complete = () => {
    const m = matches(typed);
    if (!m.length) return;
    // extend to the longest prefix every candidate shares
    let i = typed.length;
    while (m.every(w => w.length > i && w[i] === m[0][i])) i++;
    typed = m[0].slice(0, i);
    show();
  };

  const submit = () => {
    const cmd = typed.trim().toLowerCase();
    const act = cmd ? resolve(cmd) : null;
    typed = ''; typing = false;
    show();                                    // clear the buffer, restore the hint
    if (!cmd) { if (sel >= 0) links[sel].click(); return; }
    if (act) return act();
    reject(cmd);
  };

  // The highlight is a cursor for ↑↓ and Enter. On a phone there is no cursor to
  // move and nothing to press, so a row lit up on arrival reads as a selection
  // the visitor did not make — and a tap would leave it stuck there afterwards.
  // Rows are just tapped instead; the highlight stays a keyboard affordance.
  if (!TOUCH) {
    select(0, false);
    links.forEach((a, n) => a.addEventListener('mouseenter', () => select(n, false)));
  }

  // Mounting the demo re-runs chrome() on a page that already had it, so drop
  // the outgoing screen's handlers — otherwise both answer the same keystroke
  // and the old menu's bindings fire from under the new one.
  if (keyHandler) removeEventListener('keydown', keyHandler);
  if (pageHandler) removeEventListener('keydown', pageHandler);
  pageHandler = null;

  keyHandler = e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;

    // Typing a command starts with '/'. Single letters have to stay available as
    // menu hotkeys — L is the licence, J the parts index — so a typed word and a
    // hotkey cannot share the same first keystroke. Slash-prefixed commands were
    // common on real boards, and they keep both working.
    if (typing) {
      if (k === 'Enter') { e.preventDefault(); return submit(); }
      if (k === 'Tab') { e.preventDefault(); return complete(); }
      if (k === 'Escape') { e.preventDefault(); typing = false; typed = ''; show(); return; }
      if (k === 'Backspace') {
        e.preventDefault();
        typed = typed.slice(0, -1);
        if (!typed) typing = false;
        show(); return;
      }
      if (k.length === 1 && k >= ' ') { e.preventDefault(); typed += k; show(); return; }
      return;
    }
    if (k === '/') { e.preventDefault(); typing = true; typed = ''; show(); return; }

    if (k === 'Enter' && sel >= 0) { e.preventDefault(); return links[sel].click(); }
    if (k === 'Escape') { e.preventDefault(); return escape(); }
    if (k === 'Backspace') { e.preventDefault(); return escape(); }

    if (owned.has(k.toLowerCase())) return;               // the page handles this one

    if (k === 'ArrowDown') { e.preventDefault(); return select(sel + 1); }
    if (k === 'ArrowUp')   { e.preventDefault(); return select(sel - 1); }
    if (k === '?') { e.preventDefault(); return go('help.html'); }
    if (back && (k === 'q' || k === 'Q')) { e.preventDefault(); return go('/'); }

    // a single key matching a menu entry goes straight there, as on a real board
    const local = links.find(a => a.dataset.key?.toLowerCase() === k.toLowerCase());
    if (local) { e.preventDefault(); return local.click(); }
    const page = PAGES.find(p => p.key.toLowerCase() === k.toLowerCase());
    if (page) { e.preventDefault(); return go(page.file); }
  };
  addEventListener('keydown', keyHandler);

  // If a screen does overflow, space/PageDown page it like a BBS would — but
  // only when it actually overflows, and never when the page owns space.
  const body = document.querySelector('.body');
  if (body) {
    pageHandler = e => {
      if (owned.has(' ') || typing) return;
      if (body.scrollHeight <= body.clientHeight + 2) return;
      if (e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); body.scrollBy({ top: body.clientHeight * 0.85 }); }
      if (e.key === 'PageUp') { e.preventDefault(); body.scrollBy({ top: -body.clientHeight * 0.85 }); }
    };
    addEventListener('keydown', pageHandler);
  }
}

// Let a screen replace the right-hand side of the top bar — the demo screen
// uses it for a live part readout.
export function setStatus(text) {
  const el = document.getElementById('topbar-r');
  if (el) el.textContent = text;
}
