// Pure deck model: which page is showing, what each key looks like (an SVG string) and what a
// press does. The worker owns one of these; the hardware helper and the panel mirror both just
// draw the SVGs it hands out and send back the index of a pressed (or held) key.
//
// Navigation: the last key is always the page key. Tap = next page (1 → 2 → 3 → 1),
// hold = straight home to the agents page.

import { buildConfig, DEFAULT_DECK_VRX } from './deckconfig.mjs';
import { CALLSIGNS } from './fleet.mjs';

export const STATUS_COLORS = {
  GO: '#5EE6CF',
  HOLD: '#FFC34D',
  'NO-GO': '#FF5D6C',
  DONE: '#9FB3CC',
  IDLE: '#9FB3CC'
};

// One colour per agent key, so the room can tell the five apart at a glance.
// Kept clear of the GO / HOLD / NO-GO colours, which live in the status band.
export const AGENT_COLORS = ['#8B7CFF', '#38BDF8', '#F472B6', '#A3E635', '#FB923C'];

const NAV = '#7FD4FF';
const DIM = '#3C5677';
const INK = '#0A0F18';

// After these, go back to the agents page so the room sees the keys react.
const GO_HOME = new Set(['urgent', 'expand', 'focus', 'launch', 'race', 'new', 'answer']);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

const FONT = 'Menlo, SF Mono, DejaVu Sans Mono, monospace';

// Stable order for agent keys: the order Flightdeck first saw them (callsign order),
// so a key keeps its agent and its colour while statuses change.
export function callsignRank(callsign) {
  const [base, n] = String(callsign ?? '').split('-');
  const i = CALLSIGNS.indexOf(base);
  return (i < 0 ? 999 : i) + (Number(n) > 1 ? (Number(n) - 1) * CALLSIGNS.length : 0);
}

// One key face. Drawn on a 100×100 grid and scaled by the viewBox, so any key size works.
export function keySvg(face, size = 80) {
  const color = face.color ?? DIM;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">`];
  if (face.kind === 'agent') {
    const st = STATUS_COLORS[face.status] ?? DIM;
    const alarm = face.status === 'HOLD' || face.status === 'NO-GO';
    const lit = alarm && face.phase; // pulse: band fills with the status colour every other beat
    parts.push(
      `<rect width="100" height="100" fill="${color}"/>`,
      `<text x="50" y="34" font-family="${FONT}" font-size="19" font-weight="700" fill="${INK}" text-anchor="middle">${esc(clip(face.label, 7))}</text>`,
      `<text x="50" y="54" font-family="${FONT}" font-size="12" font-weight="700" fill="${INK}" fill-opacity="0.75" text-anchor="middle">${esc(clip(face.sub, 12))}</text>`,
      `<rect x="0" y="66" width="100" height="34" fill="${lit ? st : INK}"/>`,
      `<text x="50" y="89" font-family="${FONT}" font-size="15" font-weight="700" fill="${lit ? INK : st}" text-anchor="middle">${esc(face.status)}</text>`
    );
    if (alarm) parts.push(`<rect x="2" y="2" width="96" height="96" fill="none" stroke="${lit ? st : INK}" stroke-width="4"/>`);
  } else if (face.kind === 'empty') {
    parts.push(
      `<rect width="100" height="100" fill="${INK}"/>`,
      `<text x="50" y="58" font-family="${FONT}" font-size="12" fill="${DIM}" text-anchor="middle">${esc(face.label ?? '')}</text>`
    );
  } else if (face.busy) {
    // Pressed and still running: filled key, so the room sees the press landed.
    parts.push(
      `<rect width="100" height="100" fill="${color}"/>`,
      `<text x="50" y="50" font-family="${FONT}" font-size="30" fill="${INK}" text-anchor="middle">${esc(face.glyph ?? '')}</text>`,
      `<text x="50" y="74" font-family="${FONT}" font-size="15" font-weight="700" fill="${INK}" text-anchor="middle">${esc(clip(face.label, 8))}</text>`,
      `<text x="50" y="90" font-family="${FONT}" font-size="11" font-weight="700" fill="${INK}" text-anchor="middle">${face.phase ? 'working…' : 'working'}</text>`
    );
  } else {
    const off = face.disabled;
    const c = off ? DIM : color;
    parts.push(
      `<rect width="100" height="100" fill="${INK}"/>`,
      `<rect width="100" height="8" fill="${c}"/>`,
      `<text x="50" y="50" font-family="${FONT}" font-size="30" fill="${c}" text-anchor="middle">${esc(face.glyph ?? '')}</text>`,
      `<text x="50" y="74" font-family="${FONT}" font-size="15" font-weight="700" fill="${off ? DIM : '#F2F6FB'}" text-anchor="middle">${esc(clip(face.label, 8))}</text>`,
      `<text x="50" y="90" font-family="${FONT}" font-size="11" fill="#8A9BB3" text-anchor="middle">${esc(clip(off ? 'shell off' : face.sub, 12))}</text>`
    );
  }
  parts.push('</svg>');
  return parts.join('');
}

export function createDeck({ keys = 6, config = buildConfig(DEFAULT_DECK_VRX), needsShell = () => false } = {}) {
  let page = 'home';
  let count = keys;
  let cfg = config;
  let actions = [];
  let lastFaces = [];
  let shellOn = false;
  let sub = 0; // which screenful of a page that does not fit the deck
  const busy = new Set(); // "page:slot" of keys whose action is still running

  // home first, then the pages in the order the file gives (`@deck <id> pages = [...]`) or wrote them.
  function order() {
    const listed = (cfg.order ?? []).filter((p) => p === 'home' || cfg.pages[p]);
    const rest = Object.keys(cfg.pages).filter((p) => !listed.includes(p));
    const all = listed.length ? listed : ['home', ...rest];
    return all.includes('home') ? all : ['home', ...all];
  }

  const moreKey = (n, of) => ({ kind: 'nav', label: 'MORE', sub: `${n}/${of}`, glyph: '›', color: NAV, action: { type: 'more' } });

  function pageKey() {
    const o = order();
    const i = Math.max(0, o.indexOf(page));
    const title = page === 'home' ? 'agents' : (cfg.pages[page]?.title ?? page);
    return { kind: 'nav', label: `${i + 1}/${o.length} ▸`, sub: String(title).toLowerCase(), glyph: '⇄', color: NAV, action: { type: 'next' } };
  }

  // Lay items into `slots` keys. Fits → exact. Too many → screenfuls with a MORE key that cycles.
  function paginate(items, slots, placed) {
    const out = Array.from({ length: slots }, () => ({ kind: 'empty', action: { type: 'none' } }));
    if (placed && items.every((it) => it.slot <= slots)) {
      sub = 0;
      items.forEach((it) => { out[it.slot - 1] = it; });
      return out;
    }
    if (items.length <= slots) {
      sub = 0;
      items.forEach((it, i) => { out[i] = it; });
      return out;
    }
    const per = Math.max(1, slots - 1);
    const pages = Math.ceil(items.length / per);
    sub %= pages;
    items.slice(sub * per, sub * per + per).forEach((it, i) => { out[i] = it; });
    out[slots - 1] = moreKey(sub + 1, pages);
    return out;
  }

  function faces(snapshot, phase) {
    const slots = Math.max(1, count - 1); // the last key is always the page key
    if (page !== 'home' && !cfg.pages[page]) page = 'home';
    let out;
    if (page === 'home') {
      const agents = [...(snapshot?.consoles ?? [])]
        .sort((a, b) => callsignRank(a.callsign) - callsignRank(b.callsign))
        .map((a, i) => ({
          kind: 'agent',
          label: a.callsign,
          sub: a.workspace || a.agent || '',
          status: a.status,
          phase,
          color: AGENT_COLORS[i % AGENT_COLORS.length],
          action: a.terminalId ? { type: 'focus', terminalId: a.terminalId } : { type: 'none' }
        }));
      out = agents.length ? paginate(agents, slots, false) : paginate([{ kind: 'empty', label: 'no agents', action: { type: 'none' } }], slots, false);
    } else {
      const items = cfg.pages[page].keys.map((k) => {
        const { id, page: _p, slot, label, sub: subtitle, glyph, action, color, ...params } = k;
        const disabled = needsShell(action) && !shellOn;
        return { kind: 'item', slot, color: color || NAV, label, sub: subtitle, glyph, disabled, busy: busy.has(`${page}:${id}`), phase, key: id, action: disabled ? { type: 'none' } : { type: action, ...params } };
      });
      out = paginate(items, slots, true);
    }
    out.push(pageKey());
    return out;
  }

  function goto(target) {
    sub = 0;
    page = target === 'home' || cfg.pages[target] ? target : 'home';
  }

  return {
    setKeyCount(n) {
      if (Number.isInteger(n) && n > 0 && n <= 64) count = n;
    },
    setConfig(c) {
      cfg = c;
    },
    setShellAllowed(on) {
      shellOn = !!on;
    },
    get config() {
      return cfg;
    },
    get keyCount() {
      return count;
    },
    get page() {
      return page;
    },
    get pages() {
      return order();
    },
    // Which key (page + id) a press on `index` would run, so the worker can mark it busy.
    keyAt(index) {
      const f = lastFaces[index];
      return f?.kind === 'item' && f.key ? `${page}:${f.key}` : null;
    },
    setBusy(token, on) {
      if (!token) return;
      if (on) busy.add(token);
      else busy.delete(token);
    },
    get anyBusy() {
      return busy.size > 0;
    },
    // What every client should show now: one SVG per key, plus the page name.
    // `phase` flips on a timer so HOLD / NO-GO keys pulse.
    render(snapshot, size = 80, { phase = false } = {}) {
      const fs = faces(snapshot, phase);
      lastFaces = fs;
      actions = fs.map((f) => f.action);
      return { page, keys: fs.map((f) => keySvg(f, size)), labels: fs.map((f) => f.label ?? ''), errors: cfg.errors ?? [] };
    },
    // A key was tapped (on the hardware or in the mirror). Page changes happen here; anything
    // that needs Orca or the Mac is returned for the worker to run.
    press(index) {
      const action = actions[index] ?? { type: 'none' };
      if (action.type === 'more') {
        sub += 1;
        return { type: 'rerender' };
      }
      if (action.type === 'next') {
        const o = order();
        goto(o[(Math.max(0, o.indexOf(page)) + 1) % o.length]);
        return { type: 'rerender' };
      }
      if (action.type === 'page') {
        goto(action.target);
        return { type: 'rerender' };
      }
      if (GO_HOME.has(action.type)) goto('home');
      return action;
    },
    // A key was held down. The page key goes home; THEME goes back to the original look;
    // any other key acts as a tap.
    hold(index) {
      const action = actions[index] ?? { type: 'none' };
      if (action.type === 'next') {
        goto('home');
        return { type: 'rerender' };
      }
      if (action.type === 'theme') return { ...action, reset: true };
      return this.press(index);
    }
  };
}
