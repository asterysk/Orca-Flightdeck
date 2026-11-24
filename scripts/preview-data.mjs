// Sample data for screenshots: a neutral fleet, plus the deck faces Flightdeck would draw for it.
import { createDeck } from '../src/deck.mjs';
import { buildConfig, parseGrid, DEFAULT_DECK_VRX } from '../src/deckconfig.mjs';
const now = 1795000000000;
const c = (key, callsign, status, state, title, agent, workspace, project, branch, tokens, mins, trace) =>
  ({ key, callsign, status, state, terminalId: key, title, agent, workspace, project, branch, tokens, inStateMs: mins * 60e3, trace });
const consoles = [
  c('t1', 'FIDO', 'GO', 'working', 'Rendering the pricing page', 'claude', 'pricing-page', 'web-app', 'feat/pricing', 412000, 134, [1, 1, 1, 1, 1, 1, 1, 1, 1]),
  c('t2', 'GUIDO', 'HOLD', 'waiting', 'Allow write to db/migrations?', 'claude', 'billing', 'api', 'feat/billing', 188000, 6, [1, 1, 1, 1, 0.45, 0.45]),
  c('t3', 'EECOM', 'GO', 'working', 'Integration tests 41/58', 'codex', 'flaky-tests', 'api', 'fix/flaky-tests', 254000, 62, [0.45, 1, 1, 1, 1, 1]),
  c('t4', 'INCO', 'NO-GO', 'done', 'Build failed: missing env var', 'opencode', 'ios-push', 'mobile', 'ios/push', 61000, 2, [1, 1, 1, 0.1, 0.1]),
  c('t5', 'GNC', 'HOLD', 'blocked', 'Keep the old CSV export or drop it?', 'claude', 'csv-export', 'web-app', 'chore/exports', 133000, 14, [1, 1, 0.45, 0.45, 0.45])
];
export function snapshot(grid = 'mini', page = 'home', mode = 'plain') {
  const mission = mode === 'mission';
  const g = parseGrid(grid);
  const deck = createDeck({ keys: g.cols * g.rows, config: buildConfig(DEFAULT_DECK_VRX), needsShell: () => false });
  const order = { HOLD: 0, 'NO-GO': 1, GO: 2, DONE: 3, IDLE: 4 };
  const list = [...consoles].sort((a, b) => order[a.status] - order[b.status] || a.callsign.localeCompare(b.callsign));
  const counts = { GO: 0, HOLD: 0, 'NO-GO': 0, DONE: 0, IDLE: 0 };
  for (const x of list) counts[x.status]++;
  const snap = {
    mode, at: now, elapsedMs: 3 * 3600e3 + 12 * 60e3, counts, consoles: list,
    queue: list.filter((x) => x.status === 'HOLD' || x.status === 'NO-GO'),
    comms: [
      { t: now - 60e3, who: 'GUIDO', name: 'billing', status: 'HOLD', msg: 'holding, needs Flight: write migration', text: 'needs you: write migration' },
      { t: now - 120e3, who: 'INCO', name: 'ios-push', status: 'NO-GO', msg: 'failed: build', text: 'failed: build' },
      { t: now - 300e3, who: 'EECOM', name: 'flaky-tests', status: 'GO', msg: 'on loop: integration tests', text: 'running: integration tests' }
    ],
    fuel: [{ agent: 'claude', tokens: 733000 }, { agent: 'codex', tokens: 254000 }, { agent: 'opencode', tokens: 61000 }]
  };
  deck.render(snap, 80, { mission });
  if (page !== 'home') { deck.press(deck.keyCount - 1); if (page === 'tools') { deck.render(snap, 80, { mission }); deck.press(deck.keyCount - 1); } }
  const face = deck.render(snap, 80, { phase: true, mission });
  snap.deck = { ...face, cols: g.cols, rows: g.rows, model: null, screen: g.model, connected: false };
  return snap;
}
if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(JSON.stringify(snapshot(process.argv[2] || 'mini', process.argv[3] || 'home', process.argv[4] || 'plain')));
