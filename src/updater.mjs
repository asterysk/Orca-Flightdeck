// UPDATE key: tap once to check GitHub for a newer release, tap again to install it.
// Install order: Orca's own `orca plugin update` first (Git and directory installs, with Orca's
// review of new permissions); if Orca says it did not install this plugin, a quick-start clone
// is updated with `git pull --ff-only` and Orca reloads the folder.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const REPO = 'asterysk/Orca-Flightdeck';
export const PLUGIN_REF = 'asterysk.flightdeck';

const parse = (v) => {
  const m = String(v ?? '').match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return m ? m.slice(1).map(Number) : null;
};
export function newer(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
// The highest vX.Y.Z among GitHub's tag names.
export function latestTag(names) {
  return names.filter((n) => parse(n)).reduce((best, n) => (!best || newer(n, best) ? n : best), null);
}

export function createUpdater({ root, fetch = globalThis.fetch, exec, orcaBinary, log = () => {} }) {
  const current = () => {
    try { return JSON.parse(readFileSync(join(root, 'orca-plugin.json'), 'utf8')).version; } catch { return null; }
  };
  // idle | checking | latest | available | installing | installed | failed
  let state = { phase: 'idle', current: current(), latest: null, error: null };

  const sh = (file, args, opts = {}) => new Promise((resolve) => {
    exec(file, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout = '', stderr = '') => {
      resolve({ ok: !err, out: `${stdout}\n${stderr}`.trim(), err });
    });
  });

  async function check() {
    state = { ...state, phase: 'checking', current: current(), error: null };
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/tags?per_page=100`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'flightdeck-plugin' }
      });
      if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
      const latest = latestTag((await r.json()).map((t) => t.name));
      if (!latest) throw new Error('no release tags found');
      state = { ...state, latest, phase: newer(latest, state.current) ? 'available' : 'latest' };
    } catch (e) {
      state = { ...state, phase: 'failed', error: `check failed: ${e?.message ?? e}` };
    }
    return state;
  }

  async function install() {
    state = { ...state, phase: 'installing', error: null };
    const bin = await orcaBinary();
    let code = null;
    if (bin) {
      const r = await sh(bin, ['plugin', 'update', PLUGIN_REF, '--json']);
      let body = null;
      try { body = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch {}
      const res = body?.result;
      code = body?.error?.code ?? null;
      if (r.ok && body?.ok !== false) {
        state = res?.status === 'updated'
          ? { ...state, phase: 'installed' }
          : { ...state, phase: 'failed', error: `Orca: ${res?.reason ?? res?.status ?? 'nothing to update'}` };
        return state;
      }
      if (code === 'approval_required') {
        state = { ...state, phase: 'review', error: null };
        return state;
      }
      log(`orca plugin update: ${(body?.error?.message ?? r.out).slice(0, 300)}`);
    }
    // Not installed by Orca (plugin_not_found): a development folder, i.e. the quick-start clone.
    if ((!bin || code === 'plugin_not_found') && existsSync(join(root, '.git'))) {
      const r = await sh('git', ['-C', root, 'pull', '--ff-only']);
      if (r.ok) {
        state = { ...state, phase: 'installed' };
        return state;
      }
      state = { ...state, phase: 'failed', error: `git pull failed: ${r.out.slice(0, 200)}` };
      return state;
    }
    state = { ...state, phase: 'failed', error: bin ? 'orca plugin update failed (see Orca log)' : 'orca command line not found' };
    return state;
  }

  // One tap. Returns what to tell the user.
  async function tap({ canInstall }) {
    if (state.phase === 'available') {
      if (!canInstall) {
        return { title: `Update ${state.latest} ready`, body: `Set allow-shell = true in deck.vrx to install from the deck, or run: orca plugin update ${PLUGIN_REF}` };
      }
      await install();
      if (state.phase === 'installed') return { title: `Flightdeck ${state.latest} installed`, body: 'Orca reloads the plugin.' };
      if (state.phase === 'review') return { title: `Flightdeck ${state.latest} needs your approval`, body: 'It asks for new access. Open Orca Settings → Plugins and review the update.' };
      return { title: 'Update failed', body: state.error };
    }
    await check();
    if (state.phase === 'available') return { title: `Flightdeck ${state.latest} is out`, body: `You have ${state.current}. Press UPDATE again to install.` };
    if (state.phase === 'latest') return { title: 'Flightdeck is up to date', body: `Version ${state.current}.` };
    return { title: 'Update check failed', body: state.error };
  }

  // What the key shows.
  function face() {
    const s = state;
    switch (s.phase) {
      case 'available': return { sub: `${s.latest} ▸ tap`, color: '#FB923C' };
      case 'latest': return { sub: 'up to date', color: '#4ADE80' };
      case 'installed': return { sub: 'installed', color: '#4ADE80' };
      case 'review': return { sub: 'approve in Orca', color: '#FB923C' };
      case 'failed': return { sub: 'failed', color: '#F87171' };
      default: return { sub: s.current ? `v${s.current}` : 'check' };
    }
  }

  return { tap, check, install, face, get state() { return state; } };
}
