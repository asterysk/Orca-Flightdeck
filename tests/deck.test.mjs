import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { EventEmitter } from 'node:events';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeck, keySvg } from '../src/deck.mjs';
import { buildConfig, DEFAULT_DECK_VRX } from '../src/deckconfig.mjs';
import { writeFileSync, chmodSync } from 'node:fs';
import { startBridge, readRendezvous } from '../src/bridge.mjs';
import { startWorker } from '../src/worker.mjs';
import { runSession } from '../deck-helper/helper.mjs';

const tmpFile = (name = 'deck.json') => join(mkdtempSync(join(tmpdir(), 'mcdeck-')), name);
process.env.FLIGHTDECK_DECK_CONFIG = tmpFile('deck.vrx');
const snapWith = (n) => ({ consoles: Array.from({ length: n }, (_, i) => ({ callsign: 'C' + i, status: i ? 'GO' : 'HOLD', workspace: 'ws' + i, terminalId: 't' + i })), queue: [] });

test('home page: agents then the page key on the last key', () => {
  const d = createDeck({ keys: 6 });
  const f = d.render(snapWith(5));
  assert.equal(f.keys.length, 6);
  assert.equal(f.page, 'home');
  assert.deepEqual(f.labels.slice(0, 5), ['C0', 'C1', 'C2', 'C3', 'C4']);
  assert.equal(f.labels[5], '1/3 ▸');
  assert.deepEqual(d.press(0), { type: 'focus', terminalId: 't0' });
});

test('page key: tap cycles agents → mission → tools → agents, hold goes home, actions go home', () => {
  const d = createDeck({ keys: 6 });
  d.render(snapWith(2));
  assert.deepEqual(d.pages, ['home', 'mission', 'tools']);
  assert.equal(d.press(5).type, 'rerender');
  assert.equal(d.page, 'mission');
  let m = d.render(snapWith(2));
  assert.deepEqual(m.labels, ['RACE', 'PREVIEW', 'EXPAND', 'URGENT', 'THEME', '2/3 ▸']);
  d.press(5);
  m = d.render(snapWith(2));
  assert.equal(d.page, 'tools');
  assert.deepEqual(m.labels, ['GRID', 'DRIVE', 'ANSWER', 'NEW', 'ABORT', '3/3 ▸']);
  d.press(5);
  assert.equal(d.page, 'home', 'wraps round');
  d.render(snapWith(2)); d.press(5); d.render(snapWith(2)); d.press(5); d.render(snapWith(2));
  assert.equal(d.hold(5).type, 'rerender');
  assert.equal(d.page, 'home', 'hold on the page key goes straight home');
  d.render(snapWith(2)); d.press(5); d.render(snapWith(2));
  assert.equal(d.press(4).type, 'theme');
  assert.equal(d.page, 'mission', 'THEME stays, so it can be pressed again');
  d.render(snapWith(2));
  const race = d.press(0);
  assert.equal(race.type, 'race');
  assert.equal(race.count, 5);
  assert.equal(d.page, 'home', 'RACE goes home so the room sees the keys light up');
});

test('keys that run the orca command line are dimmed until allow-shell', () => {
  const d = createDeck({ keys: 6, needsShell: (a) => ['preview', 'drive'].includes(a) });
  d.render(snapWith(0)); d.press(5);
  let m = d.render(snapWith(0));
  assert.match(m.keys[1], /shell off/);
  assert.deepEqual(d.press(1), { type: 'none' });
  d.setShellAllowed(true);
  m = d.render(snapWith(0));
  assert.doesNotMatch(m.keys[1], /shell off/);
  assert.equal(d.press(1).type, 'preview');
});

test('agent keys: stable order and colour by callsign, HOLD pulses', () => {
  const d = createDeck({ keys: 6 });
  const snap = { consoles: [
    { callsign: 'GUIDO', status: 'HOLD', terminalId: 'b' },
    { callsign: 'FIDO', status: 'GO', terminalId: 'a' }
  ] };
  const a = d.render(snap, 80, { phase: false });
  assert.deepEqual(a.labels.slice(0, 2), ['FIDO', 'GUIDO'], 'callsign order, not status order');
  assert.match(a.keys[0], /#8B7CFF/);
  assert.match(a.keys[1], /#38BDF8/);
  const b = d.render(snap, 80, { phase: true });
  assert.notEqual(a.keys[1], b.keys[1], 'HOLD key changes with the beat');
  assert.equal(a.keys[0], b.keys[0], 'GO key does not');
});

test('key size follows the device and labels are escaped', () => {
  const d = createDeck({ keys: 6 });
  d.setKeyCount(15);
  assert.equal(d.render(snapWith(1)).keys.length, 15);
  const svg = keySvg({ kind: 'agent', label: '<x>', sub: 'a&b', status: 'GO' }, 72);
  assert.match(svg, /width="72"/);
  assert.doesNotMatch(svg, /<x>/);
});

function lineClient(port) {
  const sock = connect(port, '127.0.0.1');
  sock.setEncoding('utf8');
  const msgs = [];
  let buf = '';
  const waiters = [];
  sock.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      msgs.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
      for (const w of waiters.splice(0)) w();
    }
  });
  const next = (pred) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), 2000);
    const check = () => { const m = msgs.find(pred); if (m) { msgs.splice(msgs.indexOf(m), 1); clearTimeout(t); res(m); } else waiters.push(check); };
    check();
  });
  return { sock, send: (m) => sock.write(JSON.stringify(m) + '\n'), next, closed: new Promise((r) => sock.on('close', r)) };
}

test('bridge: private pairing file, wrong token is dropped, right token gets hello', async () => {
  const path = tmpFile();
  const got = [];
  const b = startBridge({ path, onMessage: (_c, m) => got.push(m) });
  const port = await b.ready;
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const rv = readRendezvous(path);
  assert.equal(rv.port, port);
  const bad = lineClient(port);
  bad.send({ type: 'auth', token: 'nope' });
  await bad.closed;
  const good = lineClient(port);
  good.send({ type: 'auth', token: rv.token });
  assert.equal((await good.next((m) => m.type === 'hello')).protocol, 1);
  good.send({ type: 'press', index: 2 });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(got, [{ type: 'press', index: 2 }]);
  good.sock.destroy();
  b.stop();
  assert.equal(readRendezvous(path), null, 'pairing file removed on stop');
});

function fakeOrca() {
  const calls = [];
  const handlers = new Map();
  const answers = {
    'settings.get': { settings: {} },
    'workspace.list': { workspaces: [{ id: 'w1', name: 'hyprReach', path: '/r', hostId: 'local', status: { state: 'active', terminalCount: 1 } }] },
    'agents.list': { agents: [{ terminalId: 't1', title: 'x', agent: 'claude', state: 'waiting' }] },
    'agent.listSessions': { sessions: [] }
  };
  return {
    calls, handlers, api: { major: 1, minor: 10 }, log: () => {},
    host: { has: () => true, call: async (n, p) => { calls.push([n, p]); return answers[n] ?? { ok: true }; } },
    panels: { handle: (n, fn) => handlers.set(n, fn), post: () => {} },
    events: { on: () => ({ dispose() {} }) }
  };
}

test('end to end: helper with a fake deck pairs, draws 6 keys, tap changes page, hold goes home, agent press focuses', async () => {
  process.env.FLIGHTDECK_DECK_FILE = tmpFile();
  const orca = fakeOrca();
  const w = startWorker(orca, { pollMs: 1e9 });
  await w.ready;
  const drawn = new Map();
  const deck = Object.assign(new EventEmitter(), {
    fillKeyBuffer: async (i, buf) => { drawn.set(i, buf.length); }
  });
  const device = { deck, model: 'Stream Deck Mini', cols: 3, rows: 2, px: { width: 80, height: 80 }, buttons: Array.from({ length: 6 }, (_, i) => ({ index: i, type: 'button' })) };
  const sharp = () => ({ resize: () => ({ removeAlpha: () => ({ raw: () => ({ toBuffer: async () => ({ data: Buffer.alloc(80 * 80 * 3) }) }) }) }) });
  const session = runSession({ device, sharp, rendezvous: () => readRendezvous(), holdMs: 80 });
  const tap = (index) => { deck.emit('down', { type: 'button', index }); deck.emit('up', { type: 'button', index }); };
  const until = async (cond) => { for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(cond()); };
  await until(() => drawn.size === 6);
  assert.equal(drawn.get(0), 80 * 80 * 3);
  const snap = await orca.handlers.get('mc.snapshot')();
  assert.equal(snap.deck.connected, true);
  assert.equal(snap.deck.model, 'Stream Deck Mini');
  tap(0);
  await until(() => orca.calls.some(([n, p]) => n === 'terminal.focus' && p.terminalId === 't1'));
  drawn.clear();
  tap(5);
  await until(() => drawn.size > 0);
  assert.equal((await orca.handlers.get('mc.snapshot')()).deck.page, 'mission');
  // Hold the page key: home, sent while the key is still down.
  deck.emit('down', { type: 'button', index: 5 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await orca.handlers.get('mc.snapshot')()).deck.page, 'home');
  deck.emit('up', { type: 'button', index: 5 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await orca.handlers.get('mc.snapshot')()).deck.page, 'home', 'release after a hold is not also a tap');
  // The panel mirror presses the same keys.
  const fwd = await orca.handlers.get('mc.deckPress')({ index: 5 });
  assert.equal(fwd.page, 'mission');
  const back = await orca.handlers.get('mc.deckPress')({ index: 5, hold: true });
  assert.equal(back.page, 'home');
  w.stop();
  assert.match(await session, /link/);
});

test('deck.vrx: default file parses cleanly; bad lines are reported, good ones kept', () => {
  assert.deepEqual(buildConfig(DEFAULT_DECK_VRX).errors, []);
  const c = buildConfig([
    '@meta verex_version = "1.0" ^vocabularies = [core-1, deck-1]',
    '@page tools title = "Tools"',
    '@key t1 page = tools',
    '@key t1 slot = 1',
    '@key t1 label = "SAY \\"HI\\""',
    '@key t1 action = url',
    '@key t1 url = "https://example.com" ^note = "x"',
    'this is not vil',
    '@key t2 page = tools',
    '@key t2 slot = 2',
    '@key t2 action = launchrocket',
    '@key t3 colour = red'
  ].join('\n'));
  assert.equal(c.pages.tools.keys.length, 1);
  assert.equal(c.pages.tools.keys[0].label, 'SAY "HI"');
  assert.equal(c.pages.tools.keys[0].url, 'https://example.com');
  assert.equal(c.errors.length, 3);
});

test('worker runs app keys, gates shell keys, and reloads deck.vrx on save', async () => {
  const cfgPath = tmpFile('deck.vrx');
  process.env.FLIGHTDECK_DECK_CONFIG = cfgPath;
  process.env.FLIGHTDECK_DECK_FILE = tmpFile();
  const vrx = (allow) => [
    `@deck mini allow-shell = ${allow}`,
    '@page menu title = "Menu"',
    '@key a page = menu', '@key a slot = 1', '@key a label = "FF"', '@key a action = app', '@key a app = "Firefox"',
    '@key b page = menu', '@key b slot = 2', '@key b label = "SH"', '@key b action = shell', '@key b run = "echo hi"'
  ].join('\n') + '\n';
  writeFileSync(cfgPath, vrx(false), { mode: 0o600 });
  const execs = [];
  const exec = (file, args, _o, cb) => { execs.push([file, ...args]); cb(null); };
  const orca = fakeOrca();
  const w = startWorker(orca, { pollMs: 1e9, exec });
  await w.ready;
  const press = (i) => orca.handlers.get('mc.deckPress')({ index: i });
  await press(5); // MENU
  await press(0); // FF
  await press(1); // SH, blocked
  assert.deepEqual(execs, [['open', '-a', 'Firefox']]);
  writeFileSync(cfgPath, vrx(true));
  chmodSync(cfgPath, 0o600);
  const until = async (cond) => { for (let i = 0; i < 150 && !cond(); i++) await new Promise((r) => setTimeout(r, 20)); };
  await until(() => false === false && execs.length > 1 || false);
  // watchFile polls once a second: give it time, then press SH again.
  await new Promise((r) => setTimeout(r, 1600));
  await press(1);
  assert.deepEqual(execs.at(-1), ['/bin/sh', '-c', 'echo hi']);
  chmodSync(cfgPath, 0o666);
  writeFileSync(cfgPath, vrx(true) + '@page extra title = "x"\n');
  await new Promise((r) => setTimeout(r, 1600));
  const n = execs.length;
  await press(1);
  assert.equal(execs.length, n, 'shell refused when the file is writable by others');
  const snap = await orca.handlers.get('mc.snapshot')();
  assert.ok(snap.deck.errors.some((e) => /allow-shell ignored/.test(e)));
  w.stop();
});

test('any grid: big decks show more, small decks page with MORE, layout by slot when it fits', () => {
  const xl = createDeck({ keys: 32 });
  const f = xl.render(snapWith(40));
  assert.equal(f.keys.length, 32);
  assert.equal(f.labels[30], 'MORE', 'more agents than keys: MORE on the second-to-last key');
  assert.equal(f.labels[31], '1/3 ▸');
  const mini = createDeck({ keys: 6 });
  let m = mini.render(snapWith(9));
  assert.deepEqual(m.labels, ['C0', 'C1', 'C2', 'C3', 'MORE', '1/3 ▸']);
  mini.press(4);
  m = mini.render(snapWith(9));
  assert.deepEqual(m.labels, ['C4', 'C5', 'C6', 'C7', 'MORE', '1/3 ▸']);
  mini.press(4); mini.press(4);
  assert.equal(mini.render(snapWith(9)).labels[0], 'C0', 'MORE wraps around');
  // A config page placed for a big deck: exact slots on the big deck, paged on the Mini.
  const lines = ['@page menu title = "M"', '@key go page = menu', '@key go slot = 1', '@key go label = "GO"', '@key go action = page', '@key go target = p', '@page p title = "P"'];
  for (const n of [1, 2, 9]) lines.push(`@key k${n} page = p`, `@key k${n} slot = ${n}`, `@key k${n} label = "K${n}"`, `@key k${n} action = refresh`);
  const cfg = buildConfig(lines.join('\n'));
  assert.deepEqual(cfg.errors, []);
  const open = (d) => { d.render(snapWith(0)); d.press(d.keyCount - 1); d.render(snapWith(0)); d.press(0); return d.render(snapWith(0)); };
  const big = open(createDeck({ keys: 15, config: cfg }));
  assert.equal(big.labels[0], 'K1');
  assert.equal(big.labels[8], 'K9', 'slot 9 lands on key 9 when it fits');
  assert.equal(big.labels[14], '3/3 ▸');
  const small = open(createDeck({ keys: 6, config: cfg }));
  assert.deepEqual(small.labels, ['K1', 'K2', 'K9', '', '', '3/3 ▸'], 'too-high slots are packed when they do not fit');
});

test('helper maps any model grid: row-major slots, keys without screens still press', async () => {
  const { openDeck } = await import('../deck-helper/helper.mjs');
  const controls = [];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) controls.push({ type: 'button', index: controls.length, row: r, column: c, feedbackType: r === 1 && c === 3 ? 'none' : 'lcd', pixelSize: { width: 120, height: 120 } });
  controls.push({ type: 'encoder', index: 0, row: 2, column: 0 });
  // The real library hands out frozen control objects.
  const lib = { listStreamDecks: async () => [{ path: 'x' }], openStreamDeck: async () => ({ CONTROLS: Object.freeze(controls.map((c) => Object.freeze(c))), PRODUCT_NAME: 'Stream Deck Neo' }) };
  const d = await openDeck(lib);
  assert.equal(d.cols, 4);
  assert.equal(d.rows, 2);
  assert.equal(d.buttons.length, 7, 'only keys with screens are drawn');
  assert.equal(d.all.length, 8);
  assert.equal(d.px.width, 120);
  assert.equal(d.all[5].slot, 5);
});

test('no hardware: the on-screen deck takes its grid from deck.vrx (model name or COLSxROWS)', async () => {
  const { parseGrid } = await import('../src/deckconfig.mjs');
  assert.deepEqual(parseGrid('xl'), { cols: 8, rows: 4, model: 'Stream Deck XL' });
  assert.deepEqual(parseGrid('5x3').cols, 5);
  assert.equal(parseGrid('0x3'), null);
  assert.equal(parseGrid('banana'), null);
  const cfgPath = tmpFile('deck.vrx');
  process.env.FLIGHTDECK_DECK_CONFIG = cfgPath;
  process.env.FLIGHTDECK_DECK_FILE = tmpFile();
  writeFileSync(cfgPath, '@deck mini grid = mk2\n@page tools title = "T"\n', { mode: 0o600 });
  const orca = fakeOrca();
  const w = startWorker(orca, { pollMs: 1e9 });
  await w.ready;
  const snap = await orca.handlers.get('mc.snapshot')();
  assert.equal(snap.deck.cols, 5);
  assert.equal(snap.deck.rows, 3);
  assert.equal(snap.deck.keys.length, 15);
  assert.equal(snap.deck.screen, 'Stream Deck MK.2');
  assert.equal(snap.deck.connected, false);
  w.stop();
});

test('deck.vrx: key color must be a hex code', () => {
  const c = buildConfig('@page p title = "P"\n@key a page = p\n@key a slot = 1\n@key a action = refresh\n@key a color = "red\\" onload=\\"x"\n');
  assert.ok(c.errors.some((e) => /hex code/.test(e)));
  assert.equal(c.pages.p.keys[0].color, undefined);
});
