// Deck buttons as Verex (VIL) statements, `deck-1` vocabulary (provisional).
// One statement per line: `@type instance attribute = value`, metadata after ` ^`.
// This is a small reader for the subset the deck needs; it can be swapped for zcvil later.

export const ACTIONS = [
  'page', 'orca', 'urgent', 'expand', 'refresh', 'focus', 'launch', 'app', 'url', 'shortcut', 'shell',
  'race', 'new', 'answer', 'abort', 'theme', 'grid', 'preview', 'phone', 'drive', 'update'
];
// Actions that run programs on the Mac (a shell, Shortcuts, or the `orca` command line):
// only run when the file says `@deck <id> allow-shell = true` and only this user can write it.
export const POWERFUL = new Set(['shortcut', 'shell', 'grid', 'preview', 'phone', 'drive']);

const ID = '[a-z][a-z0-9-]*';

function parseValue(raw) {
  const v = raw.trim();
  if (v.startsWith('"')) {
    const m = v.match(/^"((?:[^"\\]|\\.)*)"$/);
    if (!m) throw new Error('bad string');
    return m[1].replace(/\\(["\\])/g, '$1').replace(/\\n/g, '\n');
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[') && v.endsWith(']')) return v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean).map(parseValue);
  if (new RegExp(`^${ID}(\\.[a-z0-9][a-z0-9-]*)*$`).test(v)) return v; // bare enum or reference
  throw new Error('bad value');
}

// String with a closing quote inside an annotation must not end the value: match value lazily,
// but a quoted value is taken whole first.
function splitLine(line) {
  const head = line.match(new RegExp(`^@(${ID}) ([a-z0-9][a-z0-9-]*) (${ID}) = `));
  if (!head) return null;
  let rest = line.slice(head[0].length);
  let value;
  if (rest.startsWith('"')) {
    const m = rest.match(/^"(?:[^"\\]|\\.)*"/);
    if (!m) return null;
    value = m[0];
    rest = rest.slice(m[0].length);
  } else {
    const cut = rest.indexOf(' ^');
    value = cut >= 0 ? rest.slice(0, cut) : rest;
    rest = cut >= 0 ? rest.slice(cut) : '';
  }
  if (rest && !rest.startsWith(' ^')) return null;
  return { type: head[1], instance: head[2], attribute: head[3], raw: value };
}

export function parseVil(text) {
  const statements = [];
  const errors = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    if (line.startsWith('@meta ')) return; // file metadata: `@meta verex_version = "1.0" ^vocabularies = [...]`
    const s = splitLine(line);
    if (!s) {
      errors.push(`line ${i + 1}: not a VIL statement`);
      return;
    }
    try {
      statements.push({ type: s.type, instance: s.instance, attribute: s.attribute, value: parseValue(s.raw), line: i + 1 });
    } catch (e) {
      errors.push(`line ${i + 1}: ${e.message}`);
    }
  });
  return { statements, errors };
}

// The on-screen deck needs no hardware. Its grid can match any Stream Deck model, or any size.
// A connected deck always wins: its own grid replaces this one.
export const GRIDS = {
  mini: { cols: 3, rows: 2, model: 'Stream Deck Mini' },
  neo: { cols: 4, rows: 2, model: 'Stream Deck Neo' },
  plus: { cols: 4, rows: 2, model: 'Stream Deck +' },
  mk2: { cols: 5, rows: 3, model: 'Stream Deck MK.2' },
  original: { cols: 5, rows: 3, model: 'Stream Deck' },
  xl: { cols: 8, rows: 4, model: 'Stream Deck XL' }
};
export function parseGrid(v) {
  const k = String(v ?? '').toLowerCase().trim();
  if (GRIDS[k]) return { ...GRIDS[k] };
  const m = k.match(/^(\d{1,2})\s*x\s*(\d{1,2})$/);
  if (!m) return null;
  const cols = Number(m[1]);
  const rows = Number(m[2]);
  return cols >= 1 && rows >= 1 && cols * rows >= 2 && cols * rows <= 64 ? { cols, rows, model: `${cols}×${rows} grid` } : null;
}

const KEY_FIELDS = new Set([
  'page', 'slot', 'label', 'sub', 'glyph', 'action', 'color', 'target', 'agent', 'agents', 'count', 'setup', 'project',
  'workspace', 'prompt', 'app', 'url', 'name', 'run', 'text', 'enter', 'keys', 'commands', 'device', 'restore', 'find', 'fresh'
]);

export function buildConfig(text) {
  const { statements, errors } = parseVil(text);
  const config = { allowShell: false, order: [], orcaCli: null, grid: null, pages: {}, errors };
  const keys = new Map();
  for (const s of statements) {
    if (s.type === 'meta') continue;
    if (s.type === 'deck') {
      if (s.attribute === 'allow-shell') config.allowShell = s.value === true;
      else if (s.attribute === 'pages' && Array.isArray(s.value)) config.order = s.value.map(String);
      else if (s.attribute === 'orca-cli' && typeof s.value === 'string') config.orcaCli = s.value;
      else if (s.attribute === 'grid') {
        const g = parseGrid(s.value);
        if (g) config.grid = g;
        else errors.push(`line ${s.line}: grid must be a model (${Object.keys(GRIDS).join(', ')}) or "COLSxROWS" like "5x3"`);
      }
      else errors.push(`line ${s.line}: deck has no attribute "${s.attribute}"`);
      continue;
    }
    if (s.type === 'page') {
      const p = (config.pages[s.instance] ??= { id: s.instance, title: s.instance, keys: [] });
      if (s.attribute === 'title') p.title = String(s.value);
      continue;
    }
    if (s.type === 'key') {
      if (!KEY_FIELDS.has(s.attribute)) {
        errors.push(`line ${s.line}: key has no attribute "${s.attribute}"`);
        continue;
      }
      if (s.attribute === 'color' && !/^#[0-9a-f]{3,8}$/i.test(String(s.value))) {
        errors.push(`line ${s.line}: color must be a hex code like "#38BDF8"`);
        continue;
      }
      const k = (keys.get(s.instance) ?? keys.set(s.instance, { id: s.instance }).get(s.instance));
      k[s.attribute] = s.value;
      continue;
    }
    errors.push(`line ${s.line}: unknown type @${s.type}`);
  }
  for (const k of keys.values()) {
    if (!k.page || !Number.isInteger(k.slot) || k.slot < 1) {
      errors.push(`key ${k.id}: needs page and slot (1 or more)`);
      continue;
    }
    if (!ACTIONS.includes(k.action)) {
      errors.push(`key ${k.id}: action must be one of ${ACTIONS.join(', ')}`);
      continue;
    }
    const p = (config.pages[k.page] ??= { id: k.page, title: k.page, keys: [] });
    p.keys.push(k);
  }
  for (const p of Object.values(config.pages)) p.keys.sort((a, b) => a.slot - b.slot);
  return config;
}


// Write a deck as Verex statements: the inverse of buildConfig for the fields above.
const vilValue = (v) => {
  if (Array.isArray(v)) return `[${v.map(vilValue).join(', ')}]`;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (/^[a-z][a-z0-9-]*$/.test(String(v))) return String(v);
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
};

export function toVrx({ deck = 'mini', allowShell = false, grid = 'mini', pages = [], keys = [] }) {
  const out = ['@meta verex_version = "1.0" ^vocabularies = [core-1, deck-1]', `@deck ${deck} allow-shell = ${allowShell}`];
  if (grid) out.push(`@deck ${deck} grid = ${vilValue(grid)}`);
  out.push(`@deck ${deck} pages = ${vilValue(['home', ...pages.map((p) => p.id)])}`);
  for (const p of pages) {
    out.push(`@page ${p.id} title = ${vilValue(p.title)}`);
    for (const k of keys.filter((k) => k.page === p.id)) {
      for (const [attr, v] of Object.entries(k)) {
        if (attr === 'id' || v === undefined) continue;
        out.push(`@key ${k.id} ${attr} = ${vilValue(v)}`);
      }
    }
  }
  return out.join('\n') + '\n';
}

// The demo deck (Stream Deck Mini, 3×2). Page 1 is the agents; the last key on every page is
// the page key (tap: next page, hold: agents). Pages 2 and 3 are below.
export const DEMO_DECK = {
  deck: 'mini',
  pages: [
    { id: 'mission', title: 'Mission' },
    { id: 'tools', title: 'Tools' }
  ],
  keys: [
    // Page 2: Mission
    { id: 'race', page: 'mission', slot: 1, label: 'RACE', sub: 'fan out ×5', glyph: '⇶', color: '#5EE6CF', action: 'race',
      count: 5, agents: ['claude'], setup: 'skip', 
      prompt: 'Write a four-line poem about mission control to POEM.md in this folder, then stop.' },
    { id: 'preview', page: 'mission', slot: 2, label: 'PREVIEW', sub: 'browser', glyph: '◎', color: '#38BDF8', action: 'preview', url: 'https://orca.dev' },
    { id: 'expand', page: 'mission', slot: 3, label: 'EXPAND', sub: 'full room', glyph: '⤢', color: '#7FD4FF', action: 'expand' },
    // DRIVE: Orca's computer use opens Activity Monitor and searches for the agents' processes.
    { id: 'drive', page: 'tools', slot: 2, label: 'DRIVE', sub: 'experimental', glyph: '⌖', color: '#F472B6', action: 'drive',
      app: 'Activity Monitor', fresh: true, restore: true, find: 'search', text: 'claude' },
    { id: 'theme', page: 'mission', slot: 5, label: 'THEME', sub: 'recolour', glyph: '◐', color: '#FFC34D', action: 'theme' },
    // Page 3: Tools
    { id: 'grid', page: 'tools', slot: 1, label: 'GRID', sub: '2×2 panes', glyph: '▦', color: '#8B7CFF', action: 'grid',
      commands: ['top -o cpu -s 2', 'git log --graph --oneline --decorate --all --color -n 60', 'ls -la', 'uptime; df -h'] },
    { id: 'urgent', page: 'mission', slot: 4, label: 'URGENT', sub: 'worst agent', glyph: '!', color: '#FF5D6C', action: 'urgent' },
    { id: 'answer', page: 'tools', slot: 3, label: 'ANSWER', sub: 'needs you', glyph: '↩', color: '#FFC34D', action: 'answer', text: '1', enter: false },
    { id: 'new', page: 'tools', slot: 4, label: 'NEW', sub: '+1 agent', glyph: '+', color: '#A3E635', action: 'new', agents: ['claude'], setup: 'skip', 
      prompt: 'Say hello in one line, then stop.' },
    { id: 'abort', page: 'tools', slot: 5, label: 'ABORT', sub: 'stop + reset', glyph: '■', color: '#FF5D6C', action: 'abort' }
  ]
};

// What gets written the first time, so the file documents itself by example.
// Keys that run the `orca` command line stay dimmed until allow-shell is true.
export const DEFAULT_DECK_VRX = toVrx({ ...DEMO_DECK, allowShell: false });
export const DEMO_DECK_VRX = toVrx({ ...DEMO_DECK, allowShell: true });

// The demo deck with allow-shell on, optionally pinning RACE and NEW to one project.
export function demoDeckVrx(project) {
  const keys = project ? DEMO_DECK.keys.map((k) => (k.action === 'race' || k.action === 'new' ? { ...k, project } : k)) : DEMO_DECK.keys;
  return toVrx({ ...DEMO_DECK, keys, allowShell: true });
}

// Built-in last page: UPDATE (tap: check GitHub for a newer release; tap again: install it).
// Added to every deck unless the file already has an `update` key somewhere, or its own "flightdeck" page.
export const PLUGIN_PAGE = {
  id: 'flightdeck',
  title: 'Plugin',
  keys: [{ id: 'update', page: 'flightdeck', slot: 1, label: 'UPDATE', sub: 'check', glyph: '↻', color: '#A3E635', action: 'update' }]
};
export function withPluginPage(cfg) {
  const pages = Object.values(cfg.pages);
  if (cfg.pages[PLUGIN_PAGE.id] || pages.some((p) => p.keys.some((k) => k.action === 'update'))) return cfg;
  const order = cfg.order?.length ? [...cfg.order, PLUGIN_PAGE.id] : cfg.order;
  return { ...cfg, order, pages: { ...cfg.pages, [PLUGIN_PAGE.id]: { ...PLUGIN_PAGE, keys: PLUGIN_PAGE.keys.map((k) => ({ ...k })) } } };
}
