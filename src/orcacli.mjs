// Runs Orca's own command line (`orca ...`) for the things a plugin cannot do through the host API:
// terminal splits, built-in browser tabs, the phone simulator and computer use.
// Commands run with the workspace's folder as the working directory, because the CLI picks
// "the current workspace" from there.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = ['/usr/local/bin/orca', '/opt/homebrew/bin/orca', join(homedir(), '.local', 'bin', 'orca')];

export function createOrcaCli({ exec, log = () => {}, configured = () => null, exists = existsSync, env = process.env }) {
  let found = null;

  const execP = (file, args, opts) => new Promise((resolve) => {
    exec(file, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout = '', stderr = '') => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr), err });
    });
  });

  // deck.vrx `orca-cli`, then ORCA_CLI_COMMAND, then the usual install places, then the login shell.
  async function binary() {
    const pinned = configured();
    if (pinned) return pinned;
    if (found) return found;
    if (env.ORCA_CLI_COMMAND && exists(env.ORCA_CLI_COMMAND)) return (found = env.ORCA_CLI_COMMAND);
    for (const c of CANDIDATES) if (exists(c)) return (found = c);
    const r = await execP('/bin/zsh', ['-lc', 'command -v orca'], {});
    const path = r.stdout.trim().split('\n').pop();
    if (r.ok && path && exists(path)) return (found = path);
    return null;
  }

  // Run one command with --json. Resolves { ok, result } where result is the CLI's `result` object.
  async function run(args, { cwd } = {}) {
    const bin = await binary();
    if (!bin) {
      log('orca command line not found: in Orca use Settings → install the "orca" command, or set @deck <id> orca-cli = "/path/to/orca"');
      return { ok: false, result: null };
    }
    const r = await execP(bin, [...args, '--json'], { cwd: cwd || homedir() });
    let body = null;
    try { body = JSON.parse(r.stdout); } catch {}
    if (!r.ok || body?.ok === false) {
      const why = body?.error?.message ?? r.stderr.trim() ?? r.err?.message;
      log(`orca ${args.slice(0, 2).join(' ')} failed: ${String(why).slice(0, 300)}`);
      return { ok: false, result: body?.result ?? null };
    }
    return { ok: true, result: body?.result ?? null };
  }

  return { run, binary };
}
