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
  assert.match(s.comms[0].msg, /holding/);
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
  assert.deepEqual(statusBarText({ GO: 2, HOLD: 1, 'NO-GO': 0 }), { text: 'GO 2 · HOLD 1', tone: 'warning' });
  assert.equal(statusBarText({ GO: 1, HOLD: 0, 'NO-GO': 1 }).tone, 'danger');
});

function fakeOrca(minor = 10) {
  const calls = [];
  const handlers = new Map();
  const posts = [];
  let listener = null;
  const answers = {
    'settings.get': { settings: { notify: true } },
    'workspace.list': { workspaces: [{ id: 'w1', name: 'hyprReach', branch: 'main', status: { state: 'active', terminalCount: 1 } }, { id: 'w2', name: 'idle', branch: 'x', status: { state: 'inactive', terminalCount: 0 } }], truncated: false },
    'agents.list': { agents: [{ terminalId: 't1', title: 'Rendering pages', agent: 'claude', state: 'working', stateStartedAt: Date.now(), sessionId: 's1' }] },
    'agent.listSessions': { sessions: [{ sessionId: 's1', agent: 'claude', totalTokens: 1234, updatedAt: Date.now() }], truncated: false },
    'statusBar.update': { ok: true },
    'notifications.show': { delivered: true },
    'terminal.focus': { focused: true },
    'terminal.sendText': { accepted: true }
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
  await w.ready;
  const listed = orca.calls.filter(([n]) => n === 'agents.list');
  assert.equal(listed.length, 1, 'only live workspaces are listed');
  assert.deepEqual(listed[0][1], { workspaceId: 'w1' });
  const snap = orca.posts.at(-1)[1];
  assert.equal(snap.consoles[0].tokens, 1234);
  assert.ok(orca.calls.some(([n, p]) => n === 'statusBar.update' && p.text === 'GO 1'));
  orca.fire({ workspaceId: 'w1', workspaceListId: 'w1', paneKey: 'p', terminalId: 't1', state: 'blocked', receivedAt: Date.now() });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(orca.calls.some(([n, p]) => n === 'notifications.show' && /FIDO needs Flight/.test(p.title)));
  assert.equal(orca.posts.at(-1)[1].counts.HOLD, 1);
  assert.deepEqual(await orca.handlers.get('mc.reply')({ terminalId: 't1', text: 'yes' }), { accepted: true });
  assert.ok(orca.calls.some(([n, p]) => n === 'terminal.sendText' && p.enter === true && p.text === 'yes'));
  await assert.rejects(() => orca.handlers.get('mc.reply')({ terminalId: 't1', text: '' }));
  w.stop();
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
  const fs = { mkdirSync: () => {}, writeFileSync: (p, d) => files.set(p, d), existsSync: (p) => files.has(p) };
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
