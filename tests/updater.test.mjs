import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdater, newer, latestTag } from '../src/updater.mjs';
import { buildConfig, withPluginPage, DEFAULT_DECK_VRX } from '../src/deckconfig.mjs';
import { createDeck } from '../src/deck.mjs';

function pluginRoot({ version = '0.6.0', git = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fdupd-'));
  writeFileSync(join(root, 'orca-plugin.json'), JSON.stringify({ version }));
  if (git) mkdirSync(join(root, '.git'));
  return root;
}
const tags = (...names) => async () => ({ ok: true, json: async () => names.map((name) => ({ name })) });
// Fake exec: `orca plugin update` answers with `orca`, anything else (git) with `other`.
function fakeExec({ orca = { ok: true, result: { status: 'updated' } }, orcaFails = false, other = true } = {}) {
  const runs = [];
  const exec = (file, args, _opts, cb) => {
    runs.push([file, ...args]);
    if (file === '/fake/orca') cb(orcaFails ? new Error('exit 1') : null, JSON.stringify(orca), '');
    else cb(other ? null : new Error('exit 1'), '', other ? '' : 'not a fast-forward');
  };
  return { exec, runs };
}

test('version compare and newest tag', () => {
  assert.equal(newer('v0.6.1', '0.6.0'), true);
  assert.equal(newer('v0.10.0', '0.9.9'), true);
  assert.equal(newer('v0.6.0', '0.6.0'), false);
  assert.equal(latestTag(['v0.5.0', 'v0.10.0', 'v0.6.1', 'junk']), 'v0.10.0');
});

test('first tap checks, second tap installs through orca plugin update', async () => {
  const { exec, runs } = fakeExec();
  const u = createUpdater({ root: pluginRoot(), fetch: tags('v0.6.0', 'v0.6.1'), exec, orcaBinary: async () => '/fake/orca' });
  const a = await u.tap({ canInstall: true });
  assert.equal(u.state.phase, 'available');
  assert.match(a.title, /v0\.6\.1 is out/);
  assert.match(u.face().sub, /v0\.6\.1/);
  assert.equal(runs.length, 0, 'checking runs nothing');
  const b = await u.tap({ canInstall: true });
  assert.equal(u.state.phase, 'installed');
  assert.match(b.title, /installed/);
  assert.deepEqual(runs, [['/fake/orca', 'plugin', 'update', 'asterysk.flightdeck', '--json']]);
});

test('up to date: says so and installs nothing', async () => {
  const { exec, runs } = fakeExec();
  const u = createUpdater({ root: pluginRoot(), fetch: tags('v0.5.1', 'v0.6.0'), exec, orcaBinary: async () => '/fake/orca' });
  assert.match((await u.tap({ canInstall: true })).title, /up to date/);
  await u.tap({ canInstall: true });
  assert.equal(runs.length, 0);
});

test('without allow-shell the second tap only says how to update', async () => {
  const { exec, runs } = fakeExec();
  const u = createUpdater({ root: pluginRoot(), fetch: tags('v0.6.1'), exec, orcaBinary: async () => '/fake/orca' });
  await u.tap({ canInstall: false });
  const m = await u.tap({ canInstall: false });
  assert.match(m.body, /orca plugin update asterysk\.flightdeck/);
  assert.equal(runs.length, 0);
});

test('an update asking for new access waits for approval in Orca', async () => {
  const { exec } = fakeExec({ orcaFails: true, orca: { ok: false, error: { code: 'approval_required', message: 'needs approval' } } });
  const u = createUpdater({ root: pluginRoot({ git: true }), fetch: tags('v0.7.0'), exec, orcaBinary: async () => '/fake/orca' });
  await u.tap({ canInstall: true });
  const m = await u.tap({ canInstall: true });
  assert.equal(u.state.phase, 'review');
  assert.match(m.title, /approval/);
});

test('a development folder (not installed by Orca) updates with git pull --ff-only', async () => {
  const root = pluginRoot({ git: true });
  const { exec, runs } = fakeExec({ orcaFails: true, orca: { ok: false, error: { code: 'plugin_not_found' } } });
  const u = createUpdater({ root, fetch: tags('v0.6.1'), exec, orcaBinary: async () => '/fake/orca' });
  await u.tap({ canInstall: true });
  await u.tap({ canInstall: true });
  assert.equal(u.state.phase, 'installed');
  assert.deepEqual(runs[1], ['git', '-C', root, 'pull', '--ff-only']);
});

test('other orca failures never fall back to git', async () => {
  const { exec, runs } = fakeExec({ orcaFails: true, orca: { ok: false, error: { code: 'plugin_install_failed', message: 'network' } } });
  const u = createUpdater({ root: pluginRoot({ git: true }), fetch: tags('v0.6.1'), exec, orcaBinary: async () => '/fake/orca' });
  await u.tap({ canInstall: true });
  await u.tap({ canInstall: true });
  assert.equal(u.state.phase, 'failed');
  assert.equal(runs.length, 1);
});

test('a failed check shows on the key', async () => {
  const u = createUpdater({ root: pluginRoot(), fetch: async () => ({ ok: false, status: 403 }), exec: () => {}, orcaBinary: async () => null });
  const m = await u.tap({ canInstall: true });
  assert.match(m.body, /403/);
  assert.equal(u.face().sub, 'failed');
});

test('every deck gets a Plugin page with UPDATE, unless it has its own update key', () => {
  const c = withPluginPage(buildConfig(DEFAULT_DECK_VRX));
  assert.deepEqual(c.order, ['home', 'mission', 'tools', 'flightdeck']);
  const d = createDeck({ config: c });
  for (let i = 0; i < 3; i++) { d.render({ consoles: [] }); d.press(5); }
  d.setFace('update', { sub: 'v0.6.1 ▸ tap' });
  const f = d.render({ consoles: [] });
  assert.equal(f.labels[0], 'UPDATE');
  assert.equal(f.labels[5], '4/4 ▸');
  assert.match(f.keys[0], /v0\.6\.1/);
  const own = withPluginPage(buildConfig('@key u page = p\n@key u slot = 1\n@key u action = update\n'));
  assert.equal(own.pages.flightdeck, undefined);
});
