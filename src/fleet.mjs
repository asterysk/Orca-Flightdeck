// Pure fleet logic: no Orca, no Node APIs. The worker feeds it host answers and events;
// the panel renders what snapshot() returns. Kept pure so tests can drive it directly.

export const CALLSIGNS = [
  'FIDO', 'GUIDO', 'EECOM', 'INCO', 'GNC', 'RETRO', 'CAPCOM', 'SURGEON',
  'TELMU', 'BOOSTER', 'FAO', 'PAO', 'EGIL', 'NETWORK', 'PROCEDURES', 'CONTROL'
];

// Plain words for each status (the default). Mission mode shows the codes themselves.
export const PLAIN_STATUS = { GO: 'Running', HOLD: 'Needs you', 'NO-GO': 'Failed', DONE: 'Done', IDLE: 'Idle' };
export const statusWord = (status, mission = false) => (mission ? status : PLAIN_STATUS[status] ?? status);

const TRACE_LEN = 24;
const COMMS_LEN = 60;

// Orca agent state (+ outcome when done) → mission status.
export function missionStatus(state, outcome) {
  if (state === 'working') return 'GO';
  if (state === 'blocked' || state === 'waiting') return 'HOLD';
  if (state === 'done' && outcome === 'failure') return 'NO-GO';
  if (state === 'done') return 'DONE';
  return 'IDLE';
}

const ACTIVITY = { GO: 1, HOLD: 0.45, 'NO-GO': 0.1, DONE: 0.05, IDLE: 0 };

export function createFleet({ now = () => Date.now() } = {}) {
  const consoles = new Map(); // key -> console
  const callsigns = new Map(); // key -> callsign, stable for the worker's life
  const workspaces = new Map(); // id -> { name, branch, project }
  const tokensBySession = new Map(); // sessionId -> totalTokens
  const sessionsToday = []; // { agent, totalTokens }
  const comms = [];
  const startedAt = now();

  function keyOf(a) {
    return a.terminalId || a.paneKey || a.sessionId || null;
  }

  function callsignFor(key) {
    if (!callsigns.has(key)) {
      const n = callsigns.size;
      const base = CALLSIGNS[n % CALLSIGNS.length];
      callsigns.set(key, n < CALLSIGNS.length ? base : `${base}-${Math.floor(n / CALLSIGNS.length) + 1}`);
    }
    return callsigns.get(key);
  }

  // Name a person recognises: the workspace, else the agent kind.
  function nameOf(c) {
    const ws = c.workspaceId ? workspaces.get(c.workspaceId) : null;
    return ws?.name || ws?.project || c.agent || 'agent';
  }

  // Each entry carries both wordings; the panel picks one by mode.
  function log(c, from) {
    comms.unshift({ t: now(), who: c.callsign, name: nameOf(c), status: c.status, msg: describe(c, from), text: plainText(c, from) });
    if (comms.length > COMMS_LEN) comms.length = COMMS_LEN;
  }

  // Merge one agent record (from agents.list or an agent.status.changed event).
  // Returns { console, changed, from } so the worker can decide on notifications.
  function upsert(a, workspaceId) {
    const key = keyOf(a);
    if (!key) return null;
    const prev = consoles.get(key);
    const outcome = a.mainAgent?.outcome ?? a.outcome ?? prev?.outcome ?? null;
    const status = missionStatus(a.state, a.state === 'done' ? outcome : null);
    const c = prev ?? {
      key,
      callsign: callsignFor(key),
      trace: [],
      firstSeenAt: now()
    };
    c.terminalId = a.terminalId ?? c.terminalId ?? null;
    // Status events can carry an id that is not a workspace.list id; keep a known one rather than lose the name.
    const candidate = workspaceId ?? a.workspaceListId ?? a.workspaceId ?? null;
    if (candidate && (workspaces.has(candidate) || !c.workspaceId || !workspaces.has(c.workspaceId))) c.workspaceId = candidate;
    c.title = a.title ?? c.title ?? null;
    c.agent = a.agent ?? c.agent ?? null;
    c.sessionId = a.sessionId ?? c.sessionId ?? null;
    c.task = a.task?.title ?? c.task ?? null;
    c.state = a.state;
    c.outcome = a.state === 'done' ? outcome : null;
    c.stateStartedAt = a.mainAgent?.stateStartedAt ?? a.stateStartedAt ?? (prev && prev.state === a.state ? prev.stateStartedAt : now());
    const from = prev?.status ?? null;
    c.status = status;
    consoles.set(key, c);
    const changed = from !== status;
    if (changed) log(c, from);
    return { console: c, changed, from };
  }

  function describe(c, from) {
    const what = c.title || c.agent || 'agent';
    switch (c.status) {
      case 'GO': return from ? `back on loop: ${what}` : `on loop: ${what}`;
      case 'HOLD': return `holding, needs Flight: ${what}`;
      case 'NO-GO': return `failed: ${what}`;
      case 'DONE': return `complete: ${what}`;
      default: return `idle: ${what}`;
    }
  }

  function plainText(c, from) {
    const what = c.title || c.agent || 'agent';
    switch (c.status) {
      case 'GO': return from ? `running again: ${what}` : `running: ${what}`;
      case 'HOLD': return `needs you: ${what}`;
      case 'NO-GO': return `failed: ${what}`;
      case 'DONE': return `done: ${what}`;
      default: return `idle: ${what}`;
    }
  }

  // Replace the agents of one workspace with a fresh agents.list answer; agents that
  // vanished from it are dropped.
  function syncWorkspace(workspaceId, agents) {
    const seen = new Set();
    for (const a of agents) {
      const r = upsert(a, workspaceId);
      if (r) seen.add(r.console.key);
    }
    for (const [key, c] of consoles) {
      if (c.workspaceId === workspaceId && !seen.has(key)) consoles.delete(key);
    }
  }

  // New workspace list. Agents in a workspace that has gone (removed, or ABORTed) are dropped.
  function setWorkspaces(list) {
    const next = new Set(list.map((w) => w.id));
    const gone = new Set([...workspaces.keys()].filter((id) => !next.has(id)));
    workspaces.clear();
    for (const w of list) workspaces.set(w.id, { name: w.name, branch: w.branch, project: w.project ?? null });
    for (const [key, c] of consoles) if (c.workspaceId && gone.has(c.workspaceId)) consoles.delete(key);
  }

  // Drop agents by terminal id (ABORT stopped them).
  function forget(terminalIds) {
    const ids = new Set(terminalIds.filter(Boolean));
    for (const [key, c] of consoles) if (ids.has(c.terminalId) || ids.has(key)) consoles.delete(key);
  }

  function setSessions(sessions) {
    tokensBySession.clear();
    sessionsToday.length = 0;
    const midnight = new Date(now());
    midnight.setHours(0, 0, 0, 0);
    for (const s of sessions) {
      tokensBySession.set(s.sessionId, s.totalTokens || 0);
      if (s.updatedAt >= midnight.getTime()) sessionsToday.push({ agent: s.agent, totalTokens: s.totalTokens || 0 });
    }
  }

  // One sample per poll, so every console has a duty trace even with no events.
  function sample() {
    for (const c of consoles.values()) {
      c.trace.push(ACTIVITY[c.status] ?? 0);
      if (c.trace.length > TRACE_LEN) c.trace.shift();
    }
  }

  function snapshot() {
    const t = now();
    const list = [...consoles.values()].map((c) => {
      const ws = c.workspaceId ? workspaces.get(c.workspaceId) : null;
      return {
        key: c.key,
        callsign: c.callsign,
        status: c.status,
        state: c.state,
        terminalId: c.terminalId,
        title: c.title,
        agent: c.agent,
        task: c.task,
        workspace: ws?.name ?? null,
        project: ws?.project ?? null,
        branch: ws?.branch ?? null,
        tokens: c.sessionId != null ? tokensBySession.get(c.sessionId) ?? null : null,
        inStateMs: Math.max(0, t - (c.stateStartedAt || t)),
        trace: c.trace.slice()
      };
    });
    const order = { HOLD: 0, 'NO-GO': 1, GO: 2, DONE: 3, IDLE: 4 };
    list.sort((a, b) => order[a.status] - order[b.status] || a.callsign.localeCompare(b.callsign));
    const counts = { GO: 0, HOLD: 0, 'NO-GO': 0, DONE: 0, IDLE: 0 };
    for (const c of list) counts[c.status]++;
    const fuel = {};
    for (const s of sessionsToday) fuel[s.agent || 'other'] = (fuel[s.agent || 'other'] || 0) + s.totalTokens;
    return {
      at: t,
      elapsedMs: t - startedAt,
      counts,
      consoles: list,
      queue: list.filter((c) => c.status === 'HOLD' || c.status === 'NO-GO'),
      comms: comms.slice(0, 30),
      fuel: Object.entries(fuel).map(([agent, tokens]) => ({ agent, tokens })).sort((a, b) => b.tokens - a.tokens)
    };
  }

  function displayName(key) {
    const c = consoles.get(key);
    return c ? nameOf(c) : 'agent';
  }

  return { upsert, syncWorkspace, setWorkspaces, setSessions, sample, snapshot, forget, displayName };
}

export function statusBarText(counts, { mission = false } = {}) {
  const w = (k) => statusWord(k, mission);
  const parts = [`${w('GO')} ${counts.GO}`];
  if (counts.HOLD) parts.push(`${w('HOLD')} ${counts.HOLD}`);
  if (counts['NO-GO']) parts.push(`${w('NO-GO')} ${counts['NO-GO']}`);
  const tone = counts['NO-GO'] ? 'danger' : counts.HOLD ? 'warning' : counts.GO ? 'success' : 'neutral';
  return { text: parts.join(' · '), tone };
}
