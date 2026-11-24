import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker } from '../src/worker.mjs';
import { DEMO_DECK, toVrx, buildConfig, demoDeckVrx } from '../src/deckconfig.mjs';
import { THEMES, HOME_THEME } from '../src/themes.mjs';

const tmpFile = (name) => join(mkdtempSync(join(tmpdir(), 'mcdemo-')), name);

// The demo deck with a fake `orca` binary, written where the worker reads it.
function demoConfig({ allowShell = true, noProject = false } = {}) {
  const path = tmpFile('deck.vrx');
  const keys = noProject ? DEMO_DECK.keys : DEMO_DECK.keys.map((k) => (k.action === 'race' || k.action === 'new' ? { ...k, project: 'mission-demo' } : k));
  writeFileSync(path, toVrx({ ...DEMO_DECK, keys, allowShell }).replace('@deck mini pages', '@deck mini orca-cli = "/fake/orca"\n@deck mini pages'), { mode: 0o600 });
  process.env.FLIGHTDECK_DECK_CONFIG = path;
  process.env.FLIGHTDECK_DECK_FILE = tmpFile('deck.json');
}

function fakeOrca(extra = {}) {
  const calls = [];
  const handlers = new Map();
  let created = 0;
  const answers = {
    'settings.get': { settings: { deck: false } },
    'workspace.readContext': { workspaceId: 'w1', branch: 'main', displayName: 'demo', terminals: [] },
    'workspace.list': { workspaces: [{ id: 'w1', name: 'demo', path: '/repo/demo', projectId: 'p2', hostId: 'local', status: { state: 'active', terminalCount: 1 } }] },
    'project.list': { projects: [{ id: 'p1', name: 'mission-demo', kind: 'git', hostId: 'local', path: '/repo/mission-demo' }, { id: 'p2', name: 'other', kind: 'git', hostId: 'local', path: '/repo/other' }] },
    'agents.list': { agents: [{ terminalId: 't-hold', title: 'x', agent: 'claude', state: 'waiting' }] },
    'agent.listSessions': { sessions: [] },
    'appearance.read': { revision: 'a'.repeat(64) },
    'appearance.apply': { revision: 'b'.repeat(64), themeId: 'plugin:x', mode: 'dark', delivery: 'published' },
    ...extra
  };
  return {
    calls, handlers, api: { major: 1, minor: 10 }, log: () => {},
    host: {
      has: () => true,
      call: async (n, p) => {
        calls.push([n, p]);
        if (n === 'workspace.create') { created++; return { workspaceId: `race-w${created}`, terminalId: `race-t${created}` }; }
        return answers[n] ?? { ok: true };
      }
    },
    panels: { handle: (n, fn) => handlers.set(n, fn), post: () => {} },
    events: { on: () => ({ dispose() {} }) }
  };
}

// Fake exec: records every program run and answers `orca ... --json` like the real CLI.
function fakeExec() {
  const runs = [];
  let n = 0;
  const exec = (file, args, opts, cb) => {
    runs.push({ file, args, cwd: opts?.cwd });
    const [a, b] = args;
    let result = {};
    if (a === 'terminal' && b === 'create') result = { terminal: { handle: `term-${++n}` } };
    if (a === 'terminal' && b === 'split') result = { split: { handle: `term-${++n}`, tabId: 'tab' } };
    if (a === 'computer' && b === 'get-app-state') result = { snapshot: { treeText: '2 of 466 elements match "search"; showing them with their ancestors.\n0 standard window Activity Monitor – All Processes\n\t456 toolbar\n\t\t458 search text field (settable)\n\t\t\t459 button search\n' } };
    cb(null, JSON.stringify({ ok: true, result }), '');
  };
  return { exec, runs };
}

async function boot(opts = {}) {
  demoConfig(opts);
  const orca = fakeOrca(opts.answers);
  const { exec, runs } = fakeExec();
  const w = startWorker(orca, { pollMs: 1e9, exec, sleep: async () => {}, now: () => Date.UTC(2026, 10, 24, 9, 30, 15), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  await w.ready;
  const press = (index, hold = false) => orca.handlers.get('mc.deckPress')({ index, hold });
  return { orca, runs, w, press, calls: (name) => orca.calls.filter(([n]) => n === name).map(([, p]) => p) };
}

test('demo deck file parses cleanly with every key', () => {
  const c = buildConfig(toVrx({ ...DEMO_DECK, allowShell: true }));
  assert.deepEqual(c.errors, []);
  assert.equal(c.allowShell, true);
  assert.deepEqual(c.order, ['home', 'mission', 'tools']);
  assert.equal(c.pages.mission.keys.length + c.pages.tools.keys.length, 10);
});

test('RACE fans out five workspaces, each with an agent and the prompt, in the focused Git project', async () => {
  const t = await boot();
  await t.press(5); // → mission
  const face = await t.press(0); // RACE
  const made = t.calls('workspace.create');
  assert.equal(made.length, 5);
  assert.deepEqual(made.map((m) => m.name), [1, 2, 3, 4, 5].map((i) => `race-093015-${i}`));
  for (const m of made) {
    assert.equal(m.projectId, 'p1');
    assert.equal(m.agent, 'claude');
    assert.equal(m.setup, 'skip');
    assert.match(m.prompt, /POEM\.md/);
    assert.equal(m.open, false);
  }
  assert.equal(face.page, 'home');
  t.w.stop();
});

test('RACE goes to the project the key names, not the focused one, and says so when it is missing', async () => {
  const t = await boot();
  await t.press(5); await t.press(0);
  assert.ok(t.calls('workspace.create').every((m) => m.projectId === 'p1'), 'mission-demo, though "other" is focused');
  t.w.stop();
  const u = await boot({ answers: { 'project.list': { projects: [{ id: 'p2', name: 'other', kind: 'git', hostId: 'local' }] } } });
  await u.press(5); await u.press(0);
  assert.equal(u.calls('workspace.create').length, 0);
  assert.match(u.calls('notifications.show').at(-1).title, /no Git project named "mission-demo"/);
  u.w.stop();
});

test('ABORT stops what RACE started and removes its workspaces through the CLI', async () => {
  const t = await boot({ answers: {
    'workspace.list': { workspaces: [
      { id: 'w1', name: 'demo', path: '/repo/demo', projectId: 'p1', hostId: 'local', status: { state: 'active', terminalCount: 1 } },
      { id: 'race-w1', name: 'race-1', path: '/repo/race-1', projectId: 'p1', hostId: 'local' }
    ] }
  } });
  await t.press(5); await t.press(0); // RACE
  await t.press(5); await t.press(5); // → tools
  await t.press(4); // ABORT
  const sent = t.calls('terminal.sendText').filter((p) => p.text === '\u0003');
  assert.equal(sent.length, 5);
  assert.equal(t.calls('terminal.close').length, 5);
  const rm = t.runs.filter((r) => r.args[0] === 'worktree' && r.args[1] === 'rm');
  assert.deepEqual(rm.map((r) => r.args), [['worktree', 'rm', '--worktree', 'path:/repo/race-1', '--force', '--json']]);
  t.w.stop();
});

test('THEME applies Orca appearance artifacts in turn', async () => {
  const t = await boot();
  await t.press(5);
  await t.press(4);
  await t.press(4);
  const applied = t.calls('appearance.apply');
  assert.equal(applied.length, 2);
  assert.equal(applied[0].expectedRevision, 'a'.repeat(64));
  assert.equal(applied[0].app, THEMES[0].app);
  assert.equal(applied[1].terminal, THEMES[1].terminal);
  assert.notEqual(JSON.parse(THEMES[0].app).base, JSON.parse(THEMES[1].app).base, 'dark and light alternate');
  for (const th of THEMES) {
    const app = JSON.parse(th.app);
    const term = JSON.parse(th.terminal);
    assert.equal(app.base, term.mode, 'app and terminal modes match');
    assert.ok(['dark', 'light'].includes(app.base));
    assert.ok(app.tokens['--background'] && app.tokens['--foreground']);
    assert.ok(term.terminal.background && term.terminal.foreground && term.terminal.red);
  }
  t.w.stop();
});

test('GRID builds a 2×2 of panes with the orca CLI, in the focused workspace', async () => {
  const t = await boot();
  await t.press(5); await t.press(5); // → tools
  await t.press(0);
  const cli = t.runs.filter((r) => r.file === '/fake/orca');
  assert.deepEqual(cli.map((r) => r.args.slice(0, 2).join(' ')), ['terminal create', 'terminal split', 'terminal split', 'terminal split']);
  assert.ok(cli.every((r) => r.cwd === '/repo/demo'));
  assert.deepEqual(cli[1].args.slice(2, 6), ['--terminal', 'term-1', '--direction', 'vertical']);
  assert.deepEqual(cli[2].args.slice(2, 6), ['--terminal', 'term-1', '--direction', 'horizontal']);
  assert.deepEqual(cli[3].args.slice(2, 6), ['--terminal', 'term-2', '--direction', 'horizontal']);
  assert.ok(cli[0].args.includes('top -o cpu -s 2'));
  t.w.stop();
});

test('PREVIEW and DRIVE call the matching orca commands', async () => {
  const t = await boot();
  await t.press(5);
  await t.press(1); // PREVIEW
  await t.press(5); // → tools
  await t.press(1); // DRIVE
  const cli = t.runs.filter((r) => r.file === '/fake/orca').map((r) => r.args);
  assert.deepEqual(cli[0], ['tab', 'create', '--url', 'https://orca.dev', '--split', 'right', '--json']);
  assert.deepEqual(cli[1], ['computer', 'launch-app', 'Activity Monitor', '--json']);
  assert.equal(cli[2][1], 'get-app-state');
  assert.deepEqual(cli[3], ['computer', 'type-text', '--app', 'Activity Monitor', '--element-index', '458', '--text', 'claude', '--json']);
  assert.ok(t.runs.some((r) => r.file === '/usr/bin/osascript'), 'quits the app first so it opens on this desktop');
  const driveRuns = t.runs.filter((r) => r.args[0] === 'computer');
  assert.ok(driveRuns.every((r) => r.cwd === '/'), 'runs outside any workspace');
  t.w.stop();
});

test('without allow-shell the CLI keys do nothing', async () => {
  const t = await boot({ allowShell: false });
  await t.press(5);
  await t.press(1); // PREVIEW (dimmed)
  assert.equal(t.runs.length, 0);
  t.w.stop();
});

test('ANSWER shows the question on the first press and types on the second', async () => {
  const t = await boot();
  await t.press(5); await t.press(5);
  await t.press(2);
  assert.deepEqual(t.calls('terminal.sendText'), [], 'first press sends nothing');
  assert.match(t.calls('notifications.show').at(-1).title, /press again/);
  await t.press(5); await t.press(5);
  await t.press(2);
  const sent = t.calls('terminal.sendText');
  assert.deepEqual(sent, [{ terminalId: 't-hold', text: '1', enter: false }]);
  t.w.stop();
});

test('RACE that Orca refuses says why on screen', async () => {
  const t = await boot();
  t.orca.host.call = async (n, p) => {
    t.orca.calls.push([n, p]);
    if (n === 'workspace.create') throw Object.assign(new Error('setup must be skip or run'), { code: 'invalid_params' });
    if (n === 'project.list') return { projects: [{ id: 'p1', name: 'mission-demo', kind: 'git', hostId: 'local' }] };
    if (n === 'workspace.list') return { workspaces: [] };
    return { ok: true };
  };
  await t.press(5); await t.press(0);
  const shown = t.calls('notifications.show');
  assert.equal(t.calls('workspace.create').length, 1, 'stops after the first refusal');
  assert.match(shown.at(-1).title, /did not create/);
  assert.match(shown.at(-1).body, /setup must be skip or run/);
  t.w.stop();
});

test('RACE falls back to the focused worktree workspace when project.list has nothing', async () => {
  const t = await boot({ noProject: true, answers: {
    'project.list': { projects: [] },
    'workspace.list': { workspaces: [{ id: 'w1', kind: 'worktree', name: 'demo', path: '/repo/demo', projectId: 'p9', hostId: 'local' }] }
  } });
  await t.press(5); await t.press(0);
  const made = t.calls('workspace.create');
  assert.equal(made.length, 5);
  assert.equal(made[0].projectId, 'p9');
  t.w.stop();
});

test('holding THEME goes back to the Orca-dark lookalike, and the next tap starts the cycle again', async () => {
  const t = await boot();
  await t.press(5);
  await t.press(4); await t.press(4); // Mission, Daylight
  await t.press(4, true); // hold
  await t.press(4);
  const applied = t.calls('appearance.apply');
  assert.equal(applied[2].app, HOME_THEME.app);
  assert.equal(applied[3].app, THEMES[0].app);
  const app = JSON.parse(HOME_THEME.app);
  assert.equal(app.base, JSON.parse(HOME_THEME.terminal).mode);
  assert.ok(Object.values(app.tokens).every((v) => /^#[0-9a-f]{6}$/i.test(v)));
  t.w.stop();
});

test('a slow key shows "working" from the press until its action finishes', async () => {
  demoConfig();
  const orca = fakeOrca();
  const faces = [];
  orca.panels.post = (_n, snap) => faces.push(snap.deck.keys[1]);
  let release;
  const exec = (file, args, opts, cb) => { release = () => cb(null, JSON.stringify({ ok: true, result: {} }), ''); };
  const w = startWorker(orca, { pollMs: 1e9, exec, sleep: async () => {} });
  await w.ready;
  await orca.handlers.get('mc.deckPress')({ index: 5 }); // → mission
  const pending = orca.handlers.get('mc.deckPress')({ index: 1 }); // PREVIEW
  for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(faces.some((k) => /working/.test(k)), 'PREVIEW key shows working while the CLI runs');
  release();
  await pending;
  assert.doesNotMatch(faces.at(-1), /working/, 'back to normal when done');
  w.stop();
});

test('demo deck: project is optional and only pins RACE and NEW', () => {
  assert.doesNotMatch(demoDeckVrx(), /project =/);
  const pinned = buildConfig(demoDeckVrx('mission-demo'));
  assert.equal(pinned.pages.mission.keys.find((k) => k.id === 'race').project, 'mission-demo');
  assert.equal(pinned.pages.tools.keys.find((k) => k.id === 'new').project, 'mission-demo');
  assert.equal(pinned.allowShell, true);
});

test('collapse with allow-shell presses ⌘W in Orca through the orca CLI', async () => {
  const { orca, runs, w, calls } = await boot();
  try {
    assert.deepEqual(await orca.handlers.get('mc.collapse')(), { closed: true });
    const hk = runs.find((r) => r.args[0] === 'computer' && r.args[1] === 'hotkey');
    assert.ok(hk, 'ran orca computer hotkey');
    assert.deepEqual(hk.args, ['computer', 'hotkey', '--app', 'Orca', '--key', 'CmdOrCtrl+W', '--no-screenshot', '--json']);
    assert.equal(calls('terminal.focus').length, 0, 'no fallback when the key press worked');
  } finally {
    w.stop();
  }
});

test('collapse with allow-shell off does not touch the CLI', async () => {
  const { orca, runs, w, calls } = await boot({ allowShell: false });
  try {
    assert.deepEqual(await orca.handlers.get('mc.collapse')(), { closed: false, focused: 't-hold' });
    assert.ok(!runs.some((r) => r.args[0] === 'computer'));
    assert.deepEqual(calls('terminal.focus'), [{ terminalId: 't-hold' }]);
  } finally {
    w.stop();
  }
});

test('UPDATE on the Plugin page: first press checks GitHub, second installs with orca plugin update', async () => {
  const fetch = async () => ({ ok: true, json: async () => [{ name: 'v0.6.0' }, { name: 'v99.0.0' }] });
  const { orca, runs, press } = await boot({ fetch });
  let deck = await press(5); // agents -> mission
  deck = await press(5); // -> tools
  deck = await press(5); // -> plugin
  assert.equal(deck.labels[0], 'UPDATE');
  await press(0);
  deck = await press(3); // an empty key: just redraws
  assert.match(deck.keys[0], /v99\.0\.0/);
  assert.ok(orca.calls.some(([n, p]) => n === 'notifications.show' && /v99\.0\.0 is out/.test(p.title)));
  assert.equal(runs.length, 0);
  await press(0);
  assert.deepEqual(runs.at(-1).args, ['plugin', 'update', 'asterysk.flightdeck', '--json']);
  assert.equal(runs.at(-1).file, '/fake/orca');
});
