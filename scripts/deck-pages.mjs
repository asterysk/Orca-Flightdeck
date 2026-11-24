// The README's deck-pages picture: the agents page (twice, so the flashing keys show both beats),
// then the Mission and Tools pages of the default deck. Prints an HTML page; screenshot it at 2x.
// Usage: node scripts/deck-pages.mjs [plain|mission] > deck-pages.html
import { createDeck } from '../src/deck.mjs';
import { buildConfig, DEFAULT_DECK_VRX } from '../src/deckconfig.mjs';

const mission = process.argv[2] === 'mission';
const statuses = ['GO', 'HOLD', 'GO', 'NO-GO', 'DONE'];
const callsigns = ['FIDO', 'GUIDO', 'EECOM', 'INCO', 'GNC'];
const snap = { consoles: statuses.map((status, i) => ({ callsign: callsigns[i], status, workspace: `race-${i + 1}`, agent: 'claude', terminalId: `t${i}` })) };
const deck = createDeck({ keys: 6, config: buildConfig(DEFAULT_DECK_VRX), needsShell: () => false });
const svgs = (opts) => deck.render(snap, 144, { mission, ...opts }).keys;
const rows = [svgs({ phase: false }), svgs({ phase: true })];
deck.press(5);
rows.push(svgs({}));
deck.press(5);
rows.push(svgs({}));
const cell = (svg) => `<img width="144" height="144" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}">`;
process.stdout.write(`<!doctype html><body style="margin:0;background:#1F1F1F"><div style="display:grid;grid-template-columns:repeat(6,144px);gap:10px;padding:10px;width:max-content">${rows.flat().map(cell).join('')}</div></body>`);
