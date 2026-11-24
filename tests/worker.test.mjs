import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFleet, missionStatus, statusBarText } from '../src/fleet.mjs';
import { startWorker } from '../src/worker.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep the deck link's pairing file out of the real home folder.
process.env.FLIGHTDECK_DECK_FILE = join(mkdtempSync(join(tmpdir(), 'mc-')), 'deck.json');
process.env.FLIGHTDECK_DECK_CONFIG = join(mkdtempSync(join(tmpdir(), 'mc-')), 'deck.vrx');

test('mission status mapping', () => {
  assert.equal(missionStatus('working'), 'GO');
  assert.equal(missionStatus('blocked'), 'HOLD');
  assert.equal(missionStatus('waiting'), 'HOLD');
  assert.equal(missionStatus('done', 'failure'), 'NO-GO');
  assert.equal(missionStatus('done', 'success'), 'DONE');
});

test('fleet assigns stable callsigns and logs transitions', () => {
  let t = 1_000;
  const f = createFleet({ now: () => t });
  f.upsert({ terminalId: 'a', state: 'working', title: 'build' }, 'w1');
  f.upsert({ terminalId: 'b', state: 'working' }, 'w1');
  t += 5_000;
  f.upsert({ terminalId: 'a', state: 'waiting' }, 'w1');
  const s = f.snapshot();
  assert.equal(s.consoles.find((c) => c.key === 'a').callsign, 'FIDO');
  assert.equal(s.consoles.find((c) => c.key === 'b').callsign, 'GUIDO');
  assert.equal(s.counts.HOLD, 1);
  assert.equal(s.queue.length, 1);
  assert.equal(s.consoles[0].key, 'a', 'HOLD sorts first');
  assert.match(s.comms[0].msg, /holding/, 'mission wording');
  assert.match(s.comms[0].text, /^needs you: /, 'plain wording');
  assert.equal(f.displayName('a'), 'agent', 'no workspace or agent kind known yet');
});

test('syncWorkspace drops agents that left', () => {
  const f = createFleet();
  f.syncWorkspace('w1', [{ terminalId: 'a', state: 'working' }, { terminalId: 'b', state: 'working' }]);
  f.syncWorkspace('w1', [{ terminalId: 'a', state: 'working' }]);
  assert.deepEqual(f.snapshot().consoles.map((c) => c.key), ['a']);
});

test('tokens come from session history', () => {
  const f = createFleet();
  f.upsert({ terminalId: 'a', state: 'working', sessionId: 's1', agent: 'claude' }, 'w1');
  f.setSessions([{ sessionId: 's1', agent: 'claude', totalTokens: 412000, updatedAt: Date.now() }]);
  const s = f.snapshot();
  assert.equal(s.consoles[0].tokens, 412000);
  assert.deepEqual(s.fuel, [{ agent: 'claude', tokens: 412000 }]);
});

test('status bar text and tone', () => {
  assert.deepEqual(statusBarText({ GO: 2, HOLD: 1, 'NO-GO': 0 }), { text: 'Running 2 · Needs you 1', tone: 'warning' });
  assert.deepEqual(statusBarText({ GO: 2, HOLD: 1, 'NO-GO': 0 }, { mission: true }), { text: 'GO 2 · HOLD 1', tone: 'warning' });
  assert.equal(statusBarText({ GO: 0, HOLD: 0, 'NO-GO': 2 }).text, 'Running 0 · Failed 2');
  assert.equal(statusBarText({ GO: 1, HOLD: 0, 'NO-GO': 1 }).tone, 'danger');
});

function fakeOrca(minor = 10, settings = { notify: true }) {
  const calls = [];
  const handlers = new Map();
  const posts = [];
  let listener = null;
  const answers = {
    'settings.get': { settings },
    'workspace.list': { workspaces: [{ id: 'w1', name: 'hyprReach', branch: 'main', status: { state: 'active', terminalCount: 1 } }, { id: 'w2', name: 'idle', branch: 'x', status: { state: 'inactive', terminalCount: 0 } }], truncated: false },
    'agents.list': { agents: [{ terminalId: 't1', title: 'Rendering pages', agent: 'claude', state: 'working', stateStartedAt: Date.now(), sessionId: 's1' }] },
    'agent.listSessions': { sessions: [{ sessionId: 's1', agent: 'claude', totalTokens: 1234, updatedAt: Date.now() }], truncated: false },
    'statusBar.update': { ok: true },
    'notifications.show': { delivered: true },
    'terminal.focus': { focused: true },
    'terminal.sendText': { accepted: true },
    'commands.run': { ran: true }
  };
  return {
    calls, handlers, posts, fire: (e) => listener(e),
    api: { major: 1, minor },
    log: () => {},
    host: { has: () => true, call: async (name, params) => { calls.push([name, params]); return answers[name]; } },
    panels: { handle: (n, fn) => handlers.set(n, fn), post: (n, p) => posts.push([n, p]) },
    events: { on: (n, fn) => { listener = fn; return { dispose() {} }; } }
  };
}

test('worker polls, posts, updates status bar, notifies on HOLD', async () => {
  const orca = fakeOrca();
  const w = startWorker(orca, { pollMs: 1e9 });
  try {
    await w.ready;
    const listed = orca.calls.filter(([n]) => n === 'agents.list');
    assert.equal(listed.length, 1, 'only live workspaces are listed');
    assert.deepEqual(listed[0][1], { workspaceId: 'w1' });
    const snap = orca.posts.at(-1)[1];
    assert.equal(snap.consoles[0].tokens, 1234);
    assert.equal(snap.mode, 'plain', 'plain words by default');
    assert.ok(orca.calls.some(([n, p]) => n === 'statusBar.update' && p.text === 'Running 1'));
    orca.fire({ workspaceId: 'w1', workspaceListId: 'w1', paneKey: 'p', terminalId: 't1', state: 'blocked', receivedAt: Date.now() });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(orca.calls.some(([n, p]) => n === 'notifications.show' && p.title === 'hyprReach needs you'));
    assert.equal(orca.posts.at(-1)[1].counts.HOLD, 1);
    assert.deepEqual(await orca.handlers.get('mc.reply')({ terminalId: 't1', text: 'yes' }), { accepted: true });
    assert.ok(orca.calls.some(([n, p]) => n === 'terminal.sendText' && p.enter === true && p.text === 'yes'));
    await assert.rejects(() => orca.handlers.get('mc.reply')({ terminalId: 't1', text: '' }));
  } finally {
    w.stop();
  }
});

test('Mission mode setting: GO / HOLD wording, callsigns in notifications and on keys', async () => {
  const orca = fakeOrca(10, { notify: true, mission: true });
  const w = startWorker(orca, { pollMs: 1e9 });
  try {
    await w.ready;
    const snap = orca.posts.at(-1)[1];
    assert.equal(snap.mode, 'mission');
    assert.equal(snap.deck.labels[0], 'FIDO');
    assert.ok(orca.calls.some(([n, p]) => n === 'statusBar.update' && p.text === 'GO 1'));
    orca.fire({ workspaceId: 'w1', workspaceListId: 'w1', paneKey: 'p', terminalId: 't1', state: 'blocked', receivedAt: Date.now() });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(orca.calls.some(([n, p]) => n === 'notifications.show' && p.title === 'FIDO needs Flight'));
  } finally {
    w.stop();
  }
});

test('collapse without allow-shell goes back to the agent most in need, never runs close-tab', async () => {
  const orca = fakeOrca();
  const w = startWorker(orca, { pollMs: 1e9 });
  try {
    await w.ready;
    assert.deepEqual(await orca.handlers.get('mc.collapse')(), { closed: false, focused: 't1' });
    assert.ok(orca.calls.some(([n, p]) => n === 'terminal.focus' && p.terminalId === 't1'));
    assert.ok(!orca.calls.some(([n]) => n === 'commands.run'), 'Orca does not let plugins run tab.close');
    orca.host.call = async () => { throw Object.assign(new Error('nope'), { code: 'denied' }); };
    await assert.rejects(() => orca.handlers.get('mc.collapse')(), /Press ⌘W to close it/);
  } finally {
    w.stop();
  }
});

test('older Orca falls back to the focused workspace', async () => {
  const orca = fakeOrca(9);
  const w = startWorker(orca, { pollMs: 1e9 });
  await w.ready;
  const listed = orca.calls.filter(([n]) => n === 'agents.list');
  assert.equal(listed.length, 1);
  assert.equal(listed[0][1], undefined);
  w.stop();
});

test('manifest names files that exist', () => {
  const m = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url)));
  for (const p of [m.main, ...m.contributes.panels.map((x) => x.entry)]) readFileSync(new URL('../' + p, import.meta.url));
});

test('expand writes a self-ignoring room file in the focused local workspace and opens it', async () => {
  const orca = fakeOrca();
  const realCall = orca.host.call;
  orca.host.call = async (name, params) => {
    if (name === 'workspace.readContext') { orca.calls.push([name, params]); return { workspaceId: 'w1', branch: 'main', displayName: 'x', terminals: [] }; }
    if (name === 'workspace.list') { orca.calls.push([name, params]); return { workspaces: [{ id: 'w1', name: 'hyprReach', path: '/repo', hostId: 'local', status: { state: 'active', terminalCount: 1 } }], truncated: false }; }
    if (name === 'editor.open') { orca.calls.push([name, params]); return { opened: true }; }
    return realCall(name, params);
  };
  const files = new Map();
  const enoent = () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
  const fs = {
    mkdirSync: () => {},
    writeFileSync: (p, d) => files.set(p, d),
    existsSync: (p) => files.has(p),
    lstatSync: (p) => (files.has(p) ? { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false } : p === '/repo/.flightdeck' && files.size ? { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => true } : enoent())
  };
  const commands = new Map();
  orca.commands = { register: (id, fn) => { commands.set(id, fn); return { dispose() {} }; } };
  const w = startWorker(orca, { pollMs: 1e9, fs });
  await w.ready;
  const r = await orca.handlers.get('mc.expand')();
  assert.deepEqual(r, { opened: true, workspace: 'hyprReach' });
  assert.equal(files.get('/repo/.flightdeck/.gitignore'), '*\n');
  assert.ok(files.has('/repo/.flightdeck/room.flightdeck'));
  assert.ok(orca.calls.some(([n, p]) => n === 'editor.open' && p.workspaceId === 'w1' && p.path === '.flightdeck/room.flightdeck'));
  assert.ok(commands.has('expand'), 'palette command registered');
  w.stop();
});

test('manifest registers the mission room editor on the panel page', () => {
  const m = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url)));
  const ed = m.contributes.customEditors.find((e) => e.id === 'mission-room');
  assert.deepEqual(ed.extensions, ['.flightdeck']);
  assert.equal(ed.entry, 'editor/index.html');
});

test('an unknown workspace id from an event does not erase a known workspace', () => {
  const f = createFleet();
  f.setWorkspaces([{ id: 'w1', name: 'Orca mission control', branch: 'main' }]);
  f.upsert({ terminalId: 't', state: 'working' }, 'w1');
  f.upsert({ terminalId: 't', state: 'waiting' }, 'some-other-id-form');
  assert.equal(f.snapshot().consoles[0].workspace, 'Orca mission control');
});

test('editor page is the panel page plus the editor flag', async () => {
  const { editorHtml } = await import('../scripts/build-editor.mjs');
  const onDisk = readFileSync(new URL('../editor/index.html', import.meta.url), 'utf8');
  assert.equal(onDisk, editorHtml, 'run npm run build');
  assert.match(onDisk, /__MC_EDITOR = true/);
  const panel = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(panel, /__MC_EDITOR = true/);
});

test('agents in a workspace that disappears are dropped', async () => {
  const { createFleet } = await import('../src/fleet.mjs');
  const f = createFleet();
  f.setWorkspaces([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  f.syncWorkspace('a', [{ terminalId: 't1', state: 'waiting' }]);
  f.syncWorkspace('b', [{ terminalId: 't2', state: 'working' }]);
  assert.equal(f.snapshot().consoles.length, 2);
  f.setWorkspaces([{ id: 'b', name: 'B' }]);
  assert.deepEqual(f.snapshot().consoles.map((c) => c.terminalId), ['t2']);
  f.forget(['t2']);
  assert.equal(f.snapshot().consoles.length, 0);
});

test('expand refuses a planted symlink instead of overwriting its target', async () => {
  const { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync: rf } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'mc-sym-'));
  const victim = join(root, 'victim.txt');
  writeFileSync(victim, 'keep me\n');
  const run = async (repo) => {
    const orca = fakeOrca();
    const realCall = orca.host.call;
    orca.host.call = async (name, params) => {
      if (name === 'workspace.readContext') return { workspaceId: 'w1' };
      if (name === 'workspace.list') return { workspaces: [{ id: 'w1', name: 'evil', path: repo, hostId: 'local' }] };
      if (name === 'editor.open') return { opened: true };
      return realCall(name, params);
    };
    const w = startWorker(orca, { pollMs: 1e9 });
    await w.ready;
    try { return await orca.handlers.get('mc.expand')().then(() => null, (e) => e); } finally { w.stop(); }
  };
  // 1. the .flightdeck folder itself is a link
  const repoA = join(root, 'a'); mkdirSync(repoA);
  const elsewhere = join(root, 'elsewhere'); mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(repoA, '.flightdeck'));
  assert.equal((await run(repoA))?.code, 'unsafe_path');
  // 2. a file inside it is a link
  const repoB = join(root, 'b'); mkdirSync(join(repoB, '.flightdeck'), { recursive: true });
  symlinkSync(victim, join(repoB, '.flightdeck', '.gitignore'));
  assert.equal((await run(repoB))?.code, 'unsafe_path');
  assert.equal(rf(victim, 'utf8'), 'keep me\n');
  // 3. a normal repo still works
  const repoC = join(root, 'c'); mkdirSync(repoC);
  assert.equal(await run(repoC), null);
  assert.equal(rf(join(repoC, '.flightdeck', '.gitignore'), 'utf8'), '*\n');
});

test('deck bridge drops a client that never logs in', async () => {
  const { startBridge } = await import('../src/bridge.mjs');
  const { connect } = await import('node:net');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const b = startBridge({ path: join(mkdtempSync(join(tmpdir(), 'mc-br-')), 'deck.json'), authMs: 100 });
  const port = await b.ready;
  const closed = await new Promise((resolve) => {
    const s = connect(port, '127.0.0.1');
    s.on('close', () => resolve(true));
    setTimeout(() => { s.destroy(); resolve(false); }, 2000);
  });
  b.stop();
  assert.equal(closed, true);
});
