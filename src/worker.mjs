// Composition root: wires Orca's host API and agent events to the pure fleet model.
// Every host call is best-effort: failures go to orca.log and never take the worker down.
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync, lstatSync, watchFile, unwatchFile, constants as FS } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { buildConfig, DEFAULT_DECK_VRX, POWERFUL } from './deckconfig.mjs';
import { createFleet, statusBarText } from './fleet.mjs';
import { createDeck } from './deck.mjs';
import { startBridge as defaultStartBridge } from './bridge.mjs';
import { createOrcaCli } from './orcacli.mjs';
import { THEMES, HOME_THEME } from './themes.mjs';

// The element index of a text field whose line names `want`, from Orca's accessibility tree text
// ("  458 search text field (settable)"). Header lines such as "2 of 466 elements match" are not
// elements: an element line is an index followed by a role, and a field's role says "field".
export function findField(tree, want) {
  const w = want.toLowerCase();
  for (const l of tree.split('\n')) {
    const m = l.match(/^\s*(\d+)\s+(.*)$/);
    if (m && /\bfield\b/i.test(m[2]) && m[2].toLowerCase().includes(w)) return m[1];
  }
  return null;
}

const POLL_MS = 15_000;
const PULSE_MS = 700; // HOLD / NO-GO keys flash at this beat
const POST_DEBOUNCE_MS = 250;
const CONFIRM_MS = 5_000; // ANSWER: second press within this window sends
// Write a file without following a symlink at the last step (a hostile repo could plant one).
const NOFOLLOW = FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | (FS.O_NOFOLLOW ?? 0);
const STATUS_ID = 'fleet';
// Expand: a placeholder file opened in Flightdeck's custom editor, full width in the main area.
export const ROOM_DIR = '.flightdeck';
export const ROOM_FILE = 'room.flightdeck';

let running = null;

export default function activate(orca) {
  running?.stop();
  running = startWorker(orca);
  return running.ready;
}

export function deactivate() {
  running?.stop();
  running = null;
}

export function startWorker(orca, { pollMs = POLL_MS, pulseMs = PULSE_MS, now = () => Date.now(), fs = { mkdirSync, writeFileSync, existsSync, lstatSync }, startBridge = defaultStartBridge, exec = execFile, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const fleet = createFleet({ now });
  const deck = createDeck({ keys: 6, needsShell: (a) => POWERFUL.has(a) });
  let phase = false; // pulse beat for HOLD / NO-GO keys
  let bridge = null;
  let deckDevice = null; // { model, cols, rows } from the helper, once a deck is connected
  // Without hardware the on-screen deck uses the grid from deck.vrx (default: Mini, 3×2).
  const screenGrid = () => deck.config.grid ?? { cols: 3, rows: 2, model: 'Stream Deck Mini' };
  const applyGrid = () => { if (!deckDevice) { const g = screenGrid(); deck.setKeyCount(g.cols * g.rows); } };
  const has = (name) => {
    try { return orca.host.has?.(name) ?? true; } catch { return false; }
  };
  let lastError = ''; // newest host failure, for on-screen messages
  const call = async (name, params) => {
    if (!has(name)) {
      lastError = `${name} is not available in this Orca`;
      return null;
    }
    try {
      return await orca.host.call(name, params);
    } catch (error) {
      lastError = `${name}: ${error?.code ?? ''} ${error?.message ?? error}`.trim();
      orca.log(`Flightdeck: ${name} failed: ${error?.code ?? ''} ${error?.message ?? error}`);
      return null;
    }
  };
  // A deck key that fails says so on screen, not only in the log.
  const tell = (title, body) => {
    orca.log(`Flightdeck: ${title}${body ? `: ${body}` : ''}`);
    call('notifications.show', { title, ...(body ? { body: String(body).slice(0, 300) } : {}) });
  };
  const minor = () => orca.api?.minor ?? 0;

  let stopped = false;
  let timer = null;
  let postTimer = null;
  let notifyOn = true;
  let mission = false; // Mission mode: GO / HOLD / NO-GO wording and callsigns (off = plain words)

  async function readSettings() {
    const s = (await call('settings.get'))?.settings ?? {};
    notifyOn = s.notify !== false;
    mission = s.mission === true;
  }
  // Who an agent is, in the current mode's words.
  const nameFor = (c) => (mission ? c.callsign : c.workspace || c.project || c.agent || 'agent');

  async function refresh() {
    const ws = await call('workspace.list', { includeStatus: true });
    const rows = ws?.workspaces ?? [];
    fleet.setWorkspaces(rows);
    // agents.list takes a workspaceId from host API 1.10; before that only the focused one is listed.
    if (minor() >= 10) {
      const live = rows.filter((w) => w.status && (w.status.terminalCount > 0 || w.status.state !== 'inactive'));
      await Promise.all(live.map(async (w) => {
        const r = await call('agents.list', { workspaceId: w.id });
        if (r) fleet.syncWorkspace(w.id, r.agents ?? []);
      }));
    } else {
      const ctx = await call('workspace.readContext');
      const r = await call('agents.list');
      if (r) fleet.syncWorkspace(ctx?.workspaceId ?? null, r.agents ?? []);
    }
    const sessions = await call('agent.listSessions', { limit: 200 });
    if (sessions) fleet.setSessions(sessions.sessions ?? []);
  }

  function schedulePost() {
    if (postTimer || stopped) return;
    postTimer = setTimeout(() => {
      postTimer = null;
      publish();
    }, POST_DEBOUNCE_MS);
    postTimer.unref?.();
  }

  // Fleet snapshot plus the deck's current face, so the panel can mirror the hardware keys.
  function fullSnapshot() {
    const snap = fleet.snapshot();
    snap.mode = mission ? 'mission' : 'plain';
    const face = deck.render(snap, 80, { phase, mission });
    snap.deck = {
      ...face,
      cols: deckDevice?.cols ?? screenGrid().cols,
      rows: deckDevice?.rows ?? screenGrid().rows,
      model: deckDevice?.model ?? null,
      screen: deckDevice ? null : screenGrid().model,
      connected: !!bridge && bridge.clientCount > 0
    };
    return snap;
  }

  function publish({ statusBar = true } = {}) {
    const snap = fullSnapshot();
    bridge?.broadcast({ type: 'face', page: snap.deck.page, keys: snap.deck.keys });
    try {
      const sent = orca.panels.post('mc.changed', snap);
      sent?.catch?.((e) => orca.log(`Flightdeck: post failed: ${e?.message ?? e}`));
    } catch (e) {
      orca.log(`Flightdeck: post failed: ${e?.message ?? e}`);
    }
    if (statusBar) {
      const sb = statusBarText(snap.counts, { mission });
      const tooltip = mission ? 'Flightdeck: agents GO / HOLD / NO-GO' : 'Flightdeck: agents running, needing you, failed';
      call('statusBar.update', { id: STATUS_ID, text: sb.text, tone: sb.tone, tooltip });
    }
    return snap;
  }

  async function tick() {
    if (stopped) return;
    await readSettings(); // picks up a Mission mode switch within one poll
    await refresh();
    fleet.sample();
    publish();
    if (!stopped) {
      timer = setTimeout(tick, pollMs);
      timer.unref?.();
    }
  }

  function onAgentStatus(event) {
    if (stopped) return;
    const r = fleet.upsert(event, event.workspaceListId ?? event.workspaceId ?? null);
    if (!r) return;
    if (r.changed && notifyOn && (r.console.status === 'HOLD' || r.console.status === 'NO-GO')) {
      const what = r.console.title || r.console.agent || 'An agent';
      const hold = r.console.status === 'HOLD';
      const title = mission
        ? `${r.console.callsign} ${hold ? 'needs Flight' : 'is NO-GO'}`
        : `${fleet.displayName(r.console.key)} ${hold ? 'needs you' : 'failed'}`;
      call('notifications.show', { title, body: what });
    }
    schedulePost();
  }

  orca.panels.handle('mc.snapshot', async () => fullSnapshot());
  orca.panels.handle('mc.refresh', async () => {
    await refresh();
    return publish();
  });
  orca.panels.handle('mc.focus', async (input) => {
    const terminalId = typeof input?.terminalId === 'string' ? input.terminalId : null;
    if (!terminalId) throw Object.assign(new Error('terminalId required'), { code: 'invalid_params' });
    return (await call('terminal.focus', { terminalId })) ?? { focused: false };
  });
  orca.panels.handle('mc.reply', async (input) => {
    const terminalId = typeof input?.terminalId === 'string' ? input.terminalId : null;
    const text = typeof input?.text === 'string' ? input.text.slice(0, 4000) : '';
    if (!terminalId || !text) throw Object.assign(new Error('terminalId and text required'), { code: 'invalid_params' });
    return (await call('terminal.sendText', { terminalId, text, enter: true })) ?? { accepted: false };
  });

  // Open the full-width mission room: pick the focused local workspace (else the first local one),
  // make sure a self-ignoring placeholder file exists there, and open it in our custom editor.
  const isLocal = (w) => w && w.path && (w.hostId === 'local' || w.hostId == null);
  async function focusedLocalWorkspace() {
    const ctx = await call('workspace.readContext');
    const rows = (await call('workspace.list'))?.workspaces ?? [];
    return rows.find((w) => w.id === ctx?.workspaceId && isLocal(w)) ?? rows.find(isLocal) ?? null;
  }
  async function expandRoom() {
    const ws = await focusedLocalWorkspace();
    if (!ws) throw Object.assign(new Error('No local workspace to open the full-width view in.'), { code: 'no_workspace' });
    const dir = join(ws.path, ROOM_DIR);
    // Refuse symlinks: a cloned repo could point .flightdeck (or a file in it) at ~/.zshrc and friends.
    const look = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } };
    const unsafe = (p, want) => Object.assign(new Error(`Refusing to write ${p}: it is a link or not a ${want}.`), { code: 'unsafe_path' });
    const d = look(dir);
    if (d && (d.isSymbolicLink() || !d.isDirectory())) throw unsafe(dir, 'folder');
    if (!d) fs.mkdirSync(dir);
    const put = (p, data, keep) => {
      const st = look(p);
      if (st && (st.isSymbolicLink() || !st.isFile())) throw unsafe(p, 'file');
      if (!(st && keep)) fs.writeFileSync(p, data, { flag: NOFOLLOW, mode: 0o644 });
    };
    put(join(dir, '.gitignore'), '*\n', false);
    put(join(dir, ROOM_FILE), '{"missionControl":1}\n', true);
    const opened = await call('editor.open', { workspaceId: ws.id, path: `${ROOM_DIR}/${ROOM_FILE}` });
    if (!opened) throw Object.assign(new Error('Orca did not open the full-width view.'), { code: 'open_failed' });
    return { opened: true, workspace: ws.name };
  }
  orca.panels.handle('mc.expand', expandRoom);
  // The full-width view's collapse button. Plugins may not run Orca's "close tab" action, so with
  // allow-shell it presses ⌘W in Orca through Orca's own computer use: the click on the button made
  // the full-width tab the active one, so that is the tab ⌘W closes. Without allow-shell (or if the
  // key press fails) it goes back to the agent most in need instead, leaving the tab open behind it.
  orca.panels.handle('mc.collapse', async () => {
    if (shellTrusted) {
      const r = await cli.run(['computer', 'hotkey', '--app', 'Orca', '--key', 'CmdOrCtrl+W', '--no-screenshot'], { cwd: '/' });
      if (r.ok) return { closed: true };
    }
    const s = fleet.snapshot();
    const c = s.queue.find((q) => q.terminalId) ?? s.consoles.find((q) => q.terminalId);
    if (c && (await call('terminal.focus', { terminalId: c.terminalId }))) return { closed: false, focused: c.terminalId };
    throw Object.assign(new Error('Could not leave the full-width view. Press ⌘W to close it.'), { code: 'close_failed' });
  });
  try { orca.commands?.register?.('expand', () => expandRoom()); } catch (e) { orca.log(`Flightdeck: command unavailable: ${e?.message ?? e}`); }

  // A deck key was pressed, on the hardware or in the panel's mirror.
  // Deck buttons live in ~/.flightdeck/deck.vrx (Verex statements). Re-read on every save.
  const configPath = process.env.FLIGHTDECK_DECK_CONFIG || join(homedir(), '.flightdeck', 'deck.vrx');
  let shellTrusted = false; // powerful actions need allow-shell AND a file only this user can write
  function loadDeckConfig() {
    try {
      if (!existsSync(configPath)) {
        mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
        writeFileSync(configPath, DEFAULT_DECK_VRX, { mode: 0o600 });
      }
      const cfg = buildConfig(readFileSync(configPath, 'utf8'));
      // allow-shell needs a file, and a folder, that only this user owns and can write.
      const me = process.getuid?.();
      const mine = (st) => (st.mode & 0o022) === 0 && (me == null || st.uid === me);
      const fileOk = mine(statSync(configPath));
      const dirOk = mine(statSync(dirname(configPath)));
      shellTrusted = cfg.allowShell && fileOk && dirOk;
      if (cfg.allowShell && !fileOk) cfg.errors.push('allow-shell ignored: deck.vrx is writable by other users or not yours (chmod 600 it)');
      else if (cfg.allowShell && !dirOk) cfg.errors.push(`allow-shell ignored: ${dirname(configPath)} is writable by other users or not yours (chmod 700 it)`);
      deck.setConfig(cfg);
      deck.setShellAllowed(shellTrusted);
      applyGrid();
      if (cfg.errors.length) orca.log(`Flightdeck: deck.vrx: ${cfg.errors.join('; ')}`);
    } catch (e) {
      orca.log(`Flightdeck: deck.vrx unreadable: ${e?.message ?? e}`);
    }
  }
  loadDeckConfig();
  const onConfigChange = () => { loadDeckConfig(); publish(); };
  try { watchFile(configPath, { interval: 1000 }, onConfigChange); } catch {}

  const run = (file, args, opts = {}) => new Promise((resolve) => {
    exec(file, args, { timeout: 60_000, ...opts }, (err) => {
      if (err) orca.log(`Flightdeck: ${file} failed: ${err.message}`);
      resolve(!err);
    });
  });

  async function workspaceByName(name) {
    const rows = (await call('workspace.list'))?.workspaces ?? [];
    if (!name) {
      const ctx = await call('workspace.readContext');
      return rows.find((w) => w.id === ctx?.workspaceId) ?? null;
    }
    const n = String(name).toLowerCase();
    return rows.find((w) => w.name?.toLowerCase() === n) ?? rows.find((w) => w.name?.toLowerCase().includes(n)) ?? null;
  }

  // A deck key was pressed, on the hardware or in the panel's mirror.
  // Actions that take a while: the key shows "working" from the press until they finish.
  const SLOW = new Set(['race', 'new', 'abort', 'theme', 'grid', 'preview', 'phone', 'drive', 'answer', 'shell', 'shortcut', 'app']);
  async function deckPress(index, { hold = false } = {}) {
    const token = deck.keyAt(Number(index));
    const action = hold ? deck.hold(Number(index)) : deck.press(Number(index));
    if (token && SLOW.has(action.type)) {
      deck.setBusy(token, true);
      publish({ statusBar: false });
      try {
        return await runAction(action);
      } finally {
        deck.setBusy(token, false);
        publish({ statusBar: false });
      }
    }
    return runAction(action);
  }

  async function runAction(action) {
    if (POWERFUL.has(action.type) && !shellTrusted) {
      orca.log(`Flightdeck: "${action.type}" key ignored: set @deck <id> allow-shell = true in deck.vrx`);
      return publish().deck;
    }
    switch (action.type) {
      case 'focus': {
        if (action.terminalId) {
          await call('terminal.focus', { terminalId: action.terminalId });
          break;
        }
        const ws = await workspaceByName(action.workspace);
        const agent = ws && fleet.snapshot().consoles.find((c) => c.workspace === ws.name && c.terminalId);
        if (agent) await call('terminal.focus', { terminalId: agent.terminalId });
        else if (ws) await call('workspace.open', { workspaceId: ws.id });
        break;
      }
      case 'urgent': {
        const first = fleet.snapshot().queue.find((c) => c.terminalId);
        if (first) await call('terminal.focus', { terminalId: first.terminalId });
        break;
      }
      case 'expand':
        await expandRoom().catch((e) => orca.log(`Flightdeck: expand failed: ${e?.message ?? e}`));
        break;
      case 'refresh':
        await refresh();
        break;
      case 'orca':
        if (action.target) await call('commands.run', { action: String(action.target) });
        break;
      case 'launch': {
        const ws = await workspaceByName(action.workspace);
        if (ws) await call('agent.launch', { workspaceId: ws.id, agent: String(action.agent || 'claude'), ...(action.prompt ? { prompt: String(action.prompt) } : {}) });
        else orca.log('Flightdeck: launch key: no such workspace');
        break;
      }
      case 'app':
        if (action.app) await run('open', ['-a', String(action.app)]);
        break;
      case 'url':
        if (/^https?:\/\//.test(String(action.url))) await run('open', [String(action.url)]);
        break;
      case 'shortcut':
        if (action.name) await run('shortcuts', ['run', String(action.name)]);
        break;
      case 'shell':
        if (action.run) await run('/bin/sh', ['-c', String(action.run)], { cwd: homedir() });
        break;
      case 'race':
        await race(action, clampCount(action.count, 5), 'race');
        break;
      case 'new':
        await race(action, 1, 'agent');
        break;
      case 'answer':
        await answer(action);
        break;
      case 'abort':
        await abort();
        break;
      case 'theme':
        await nextTheme({ reset: action.reset === true });
        break;
      case 'grid':
        await grid(action);
        break;
      case 'preview':
        await inWorkspace((cwd) => cli.run(['tab', 'create', '--url', String(action.url || 'https://orca.dev'), '--split', 'right'], { cwd }));
        break;
      case 'phone':
        await inWorkspace((cwd) => cli.run(['emulator', 'attach', ...(action.device ? [String(action.device)] : []), '--focus'], { cwd }));
        break;
      case 'drive':
        await drive(action);
        break;
      default:
        break;
    }
    return publish().deck;
  }
  orca.panels.handle('mc.deckPress', async (input) => deckPress(input?.index, { hold: input?.hold === true }));

  // ---- Demo actions -------------------------------------------------------------------------
  const cli = createOrcaCli({ exec, log: (m) => tell('Flightdeck', m), configured: () => deck.config.orcaCli });
  const launched = []; // { workspaceId, terminalId } this plugin started, for ABORT
  let themeAt = -1;

  const clampCount = (n, dflt) => (Number.isInteger(n) && n >= 1 ? Math.min(n, 12) : dflt);
  const listOf = (v, dflt) => (Array.isArray(v) && v.length ? v.map(String) : v ? [String(v)] : dflt);
  const stamp = () => new Date(now()).toISOString().slice(11, 19).replace(/:/g, '');

  async function inWorkspace(fn) {
    const ws = await focusedLocalWorkspace();
    if (!ws) {
      tell('Open a local workspace first', 'This key works in the focused workspace.');
      return null;
    }
    return fn(ws.path, ws);
  }

  // A Git project to fan out in: the named workspace's, else the focused one's, else the first.
  // A worktree workspace is always in a Git project, so its projectId works even when
  // project.list is missing or says nothing useful.
  async function gitProject(action) {
    const projects = (await call('project.list'))?.projects ?? [];
    const git = (id) => projects.find((p) => p.id === id && p.kind === 'git');
    // A named project wins, so RACE lands in the demo repo whatever is focused.
    if (action.project) {
      const n = String(action.project).toLowerCase();
      const named = projects.find((p) => p.kind === 'git' && (p.name?.toLowerCase() === n || p.path?.toLowerCase().endsWith(`/${n}`)));
      if (named) return named;
      tell(`RACE: no Git project named "${action.project}"`, 'Add it to Orca (orca repo add --path …) or change project in deck.vrx.');
      return undefined;
    }
    const ws = action.workspace ? await workspaceByName(action.workspace) : await focusedLocalWorkspace();
    const fromRow = (w) => (w?.projectId && w.kind === 'worktree' ? { id: w.projectId, hostId: w.hostId ?? null } : null);
    const rows = (await call('workspace.list'))?.workspaces ?? [];
    return git(ws?.projectId) ?? fromRow(ws) ?? projects.find((p) => p.kind === 'git' && !p.hidden)
      ?? fromRow(rows.find((w) => w.kind === 'worktree' && w.projectId && isLocal(w))) ?? null;
  }

  // RACE / NEW: new workspaces (branch + worktree each), each starting an agent with the prompt.
  async function race(action, n, prefix) {
    const project = await gitProject(action);
    if (project === undefined) return;
    if (!project) {
      const seen = (await call('project.list'))?.projects ?? [];
      orca.log(`Flightdeck: RACE found no Git project. project.list: ${JSON.stringify(seen.map((p) => ({ name: p.name, kind: p.kind, hidden: !!p.hidden })))}`);
      tell('RACE: no Git project', 'Add a Git repository to Orca as a project, open it, then press RACE again.');
      return;
    }
    const agents = listOf(action.agents ?? action.agent, ['claude']);
    const tag = stamp();
    for (let i = 0; i < n; i++) {
      const r = await call('workspace.create', {
        projectId: project.id,
        ...(project.hostId && project.hostId !== 'local' ? { hostId: project.hostId } : {}),
        name: n > 1 ? `${prefix}-${tag}-${i + 1}` : `${prefix}-${tag}`,
        agent: agents[i % agents.length],
        ...(action.prompt ? { prompt: String(action.prompt) } : {}),
        ...(action.setup === 'skip' ? { setup: 'skip' } : {}),
        open: false
      });
      if (!r?.workspaceId) {
        tell('RACE: Orca did not create the workspace', lastError);
        return;
      }
      launched.push({ workspaceId: r.workspaceId, terminalId: r.terminalId ?? null });
      await refresh();
      publish();
    }
  }

  // ANSWER: type into the agent most in need (first in the Awaiting Flight queue).
  // Two presses: the first shows what that agent is asking, the second (within 5 s, same agent) sends.
  // Agents often read "1" as "yes, allow", so one press must never approve something unseen.
  let armed = null; // { terminalId, until }
  async function answer(action) {
    const c = fleet.snapshot().queue.find((q) => q.terminalId);
    if (!c) return;
    const text = String(action.text ?? '1');
    if (!(armed && armed.terminalId === c.terminalId && now() <= armed.until)) {
      armed = { terminalId: c.terminalId, until: now() + CONFIRM_MS };
      tell(`ANSWER ${nameFor(c)}: press again to send "${text}"`, c.title || c.task || 'Waiting for input');
      return;
    }
    armed = null;
    if (text) await call('terminal.sendText', { terminalId: c.terminalId, text, enter: false });
    if (action.enter !== false) await call('terminal.sendText', { terminalId: c.terminalId, text: '', enter: true });
  }

  // ABORT: stop every agent RACE / NEW started, close their terminals, and (with allow-shell)
  // remove their workspaces so the next run starts clean.
  async function abort() {
    const runs = launched.splice(0);
    for (const r of runs) {
      if (!r.terminalId) continue;
      await call('terminal.sendText', { terminalId: r.terminalId, text: '\u0003', enter: false });
      await call('terminal.close', { terminalId: r.terminalId });
    }
    if (shellTrusted && runs.length) {
      const rows = (await call('workspace.list'))?.workspaces ?? [];
      for (const r of runs) {
        const ws = rows.find((w) => w.id === r.workspaceId);
        if (ws?.path) await cli.run(['worktree', 'rm', '--worktree', `path:${ws.path}`, '--force']);
      }
    }
    fleet.forget(runs.map((r) => r.terminalId));
    await refresh();
  }

  // THEME: recolour the whole Orca window and every terminal; steps through THEMES.
  async function nextTheme({ reset = false } = {}) {
    let t;
    if (reset) {
      themeAt = -1;
      t = HOME_THEME;
    } else {
      themeAt = (themeAt + 1) % THEMES.length;
      t = THEMES[themeAt];
    }
    const cur = await call('appearance.read');
    if (!cur?.revision) return;
    const r = await call('appearance.apply', { expectedRevision: cur.revision, app: t.app, terminal: t.terminal });
    if (r) orca.log(`Flightdeck: theme ${t.name}`);
  }

  // GRID: a new terminal tab split into a 2×2 grid, one command per pane.
  async function grid(action) {
    const cmds = listOf(action.commands, []);
    const withCmd = (i) => (cmds[i] ? ['--command', cmds[i], '--keep-open'] : []);
    await inWorkspace(async (cwd) => {
      const a = await cli.run(['terminal', 'create', '--title', 'GRID', '--focus', ...withCmd(0)], { cwd });
      const h0 = a.result?.terminal?.handle;
      if (!h0) return;
      const b = await cli.run(['terminal', 'split', '--terminal', h0, '--direction', 'vertical', ...withCmd(1)], { cwd });
      const h1 = b.result?.split?.handle;
      await cli.run(['terminal', 'split', '--terminal', h0, '--direction', 'horizontal', ...withCmd(2)], { cwd });
      if (h1) await cli.run(['terminal', 'split', '--terminal', h1, '--direction', 'horizontal', ...withCmd(3)], { cwd });
    });
  }

  // DRIVE: Orca's computer use opens a Mac app and types into it.
  // - Runs from / so the CLI is not inside an Orca workspace (your home folder can be one or two).
  // - `find` names a field to type into (e.g. "search"): its element index is read from the app's
  //   accessibility tree, so no keyboard shortcut or window focus is needed.
  // - `restore` brings the window forward for keys that need focus; on stage that is the point.
  // - `fresh` quits the app first, so it opens on the current desktop (macOS hides windows on
  //   other Spaces from accessibility).
  async function drive(action) {
    const app = String(action.app || 'Activity Monitor');
    const front = action.restore !== false ? ['--restore-window'] : [];
    const at = { cwd: '/' };
    if (action.fresh) {
      await run('/usr/bin/osascript', ['-e', `quit app "${app.replace(/"/g, '')}"`]);
      await sleep(1500);
    }
    const ok = await cli.run(['computer', 'launch-app', app], at);
    if (!ok.ok) return;
    await sleep(2500);
    if (action.find && action.text) {
      const st = await cli.run(['computer', 'get-app-state', '--app', app, '--query', String(action.find), ...front], at);
      const index = findField(String(st.result?.snapshot?.treeText ?? ''), String(action.find));
      if (index) {
        await cli.run(['computer', 'type-text', '--app', app, '--element-index', index, '--text', String(action.text)], at);
        return;
      }
      tell('DRIVE: field not found', `No "${action.find}" field in ${app}; typing into the front window instead.`);
    }
    if (action.keys) {
      await cli.run(['computer', 'hotkey', '--app', app, '--key', String(action.keys), ...front], at);
      await sleep(600);
    }
    if (action.text) await cli.run(['computer', 'type-text', '--app', app, '--text', String(action.text), ...front], at);
  }

  // Pulse: while the agents page shows a HOLD or NO-GO key, flip the beat and redraw the deck.
  const pulse = setInterval(() => {
    if (stopped) return;
    const alarm = deck.anyBusy || (deck.page === 'home' && fleet.snapshot().consoles.some((c) => c.status === 'HOLD' || c.status === 'NO-GO'));
    if (!alarm && !phase) return;
    phase = alarm ? !phase : false;
    publish({ statusBar: false });
  }, pulseMs);
  pulse.unref?.();

  async function startDeckBridge() {
    const s = (await call('settings.get'))?.settings ?? {};
    if (s.deck === false) return;
    try {
      bridge = startBridge({
        log: (m) => orca.log(`Flightdeck: ${m}`),
        onConnect: () => publish(),
        onDisconnect: () => { if (bridge && bridge.clientCount === 0) { deckDevice = null; applyGrid(); } publish(); },
        onMessage: (_client, msg) => {
          if (msg?.type === 'device') {
            const cols = Number(msg.cols);
            const rows = Number(msg.rows);
            if (cols > 0 && rows > 0) {
              deckDevice = { model: String(msg.model ?? ''), cols, rows };
              deck.setKeyCount(cols * rows);
            }
            publish();
          } else if (msg?.type === 'press' || msg?.type === 'hold') {
            deckPress(msg.index, { hold: msg.type === 'hold' }).catch((e) => orca.log(`Flightdeck: deck press failed: ${e?.message ?? e}`));
          }
        }
      });
      await bridge.ready;
    } catch (e) {
      orca.log(`Flightdeck: deck bridge unavailable: ${e?.message ?? e}`);
      bridge = null;
    }
  }

  let sub = null;
  try {
    sub = orca.events?.on?.('agent.status.changed', onAgentStatus) ?? null;
  } catch (e) {
    orca.log(`Flightdeck: agent events unavailable: ${e?.message ?? e}`);
  }

  const ready = (async () => {
    await readSettings();
    await startDeckBridge();
    await tick();
  })().catch((e) => orca.log(`Flightdeck: start failed: ${e?.message ?? e}`));

  return {
    ready,
    fleet,
    onAgentStatus,
    stop() {
      stopped = true;
      try { bridge?.stop(); } catch {}
      try { unwatchFile(configPath, onConfigChange); } catch {}
      clearTimeout(timer);
      clearTimeout(postTimer);
      clearInterval(pulse);
      try { sub?.dispose?.(); } catch {}
    }
  };
}
