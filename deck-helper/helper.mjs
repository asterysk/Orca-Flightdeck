// Flightdeck deck helper: owns the Stream Deck over USB and mirrors what Flightdeck decides.
// It knows nothing about agents: it draws the key pictures the worker sends and reports presses.
// Quit the Elgato Stream Deck app first; only one program can own the deck at a time.
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const RENDEZVOUS = process.env.FLIGHTDECK_DECK_FILE || join(homedir(), '.flightdeck', 'deck.json');
const RETRY_MS = 3000;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function readRendezvous() {
  try {
    const v = JSON.parse(readFileSync(RENDEZVOUS, 'utf8'));
    return Number.isInteger(v.port) && typeof v.token === 'string' ? v : null;
  } catch {
    return null;
  }
}

// SVG → raw RGB at the key's pixel size.
export async function rasterize(svg, width, height, sharp) {
  const { data } = await sharp(Buffer.from(svg)).resize(width, height).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return data;
}

export async function openDeck(lib) {
  const list = await lib.listStreamDecks();
  if (!list.length) return null;
  const deck = await lib.openStreamDeck(list[0].path);
  // Every model: Mini 3×2, MK.2 5×3, XL 8×4, Neo, Plus (keys only; dials later), Pedal (no screens).
  const keys = deck.CONTROLS.filter((c) => c.type === 'button');
  if (!keys.length) throw new Error('this Stream Deck has no keys');
  const cols = Math.max(...keys.map((b) => b.column)) + 1;
  const rows = Math.max(...keys.map((b) => b.row)) + 1;
  // Key index → position in the row-major grid the worker draws for. The library's control
  // objects are frozen, so work on copies.
  const all = keys.map((b) => ({ ...b, slot: b.row * cols + b.column }));
  const buttons = all.filter((b) => b.feedbackType === 'lcd');
  const px = buttons[0]?.pixelSize ?? { width: 72, height: 72 };
  return { deck, buttons, all, cols, rows, px, model: deck.PRODUCT_NAME ?? deck.MODEL ?? 'Stream Deck' };
}

// Runs one session: deck + link. Resolves when either side goes away.
export const HOLD_MS = 500;

export async function runSession({ device, sharp, net = { connect }, rendezvous = readRendezvous, holdMs = HOLD_MS }) {
  const rv = rendezvous();
  if (!rv) throw new Error(`Flightdeck is not running (no ${RENDEZVOUS})`);
  const sock = net.connect(rv.port, '127.0.0.1');
  sock.setEncoding('utf8');
  const send = (m) => sock.write(JSON.stringify(m) + '\n');
  let lastKeys = [];

  async function draw(keys) {
    for (const b of device.buttons) {
      const at = b.slot ?? b.index;
      const svg = keys[at];
      if (!svg || svg === lastKeys[at]) continue;
      const rgb = await rasterize(svg, device.px.width, device.px.height, sharp);
      await device.deck.fillKeyBuffer(b.index, rgb, { format: 'rgb' });
    }
    lastKeys = keys.slice();
  }

  // Tap = released before HOLD_MS; hold = still down at HOLD_MS (sent then, without waiting for release).
  const slotOf = (control) => (Number.isInteger(control.slot) ? control.slot
    : Number.isInteger(control.row) && Number.isInteger(control.column) ? control.row * device.cols + control.column
    : control.index);
  const timers = new Map(); // slot -> timer while the key is down
  const onDown = (control) => {
    if (control?.type !== 'button') return;
    const slot = slotOf(control);
    clearTimeout(timers.get(slot));
    timers.set(slot, setTimeout(() => {
      timers.set(slot, null);
      send({ type: 'hold', index: slot });
    }, holdMs));
  };
  const onUp = (control) => {
    if (control?.type !== 'button') return;
    const slot = slotOf(control);
    if (!timers.has(slot)) return;
    const t = timers.get(slot);
    timers.delete(slot);
    if (t === null) return; // already sent as a hold
    clearTimeout(t);
    send({ type: 'press', index: slot });
  };
  device.deck.on('down', onDown);
  device.deck.on('up', onUp);

  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      device.deck.off?.('down', onDown);
      device.deck.off?.('up', onUp);
      for (const t of timers.values()) clearTimeout(t);
      sock.destroy();
      resolve(why);
    };
    sock.on('connect', () => {
      send({ type: 'auth', token: rv.token });
      send({ type: 'device', model: device.model, cols: device.cols, rows: device.rows });
      log(`linked to Flightdeck; deck ${device.model} ${device.cols}×${device.rows}`);
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'face' && Array.isArray(msg.keys)) draw(msg.keys).catch((e) => log('draw failed:', e?.message ?? e));
      }
    });
    sock.on('close', () => finish('link closed'));
    sock.on('error', (e) => finish(`link error: ${e.message}`));
    device.deck.on('error', (e) => finish(`deck error: ${e?.message ?? e}`));
  });
}

async function main() {
  const lib = await import('@elgato-stream-deck/node');
  const sharp = (await import('sharp')).default;
  log('Flightdeck deck helper starting. Quit the Elgato Stream Deck app if it is running.');
  for (;;) {
    let device = null;
    try {
      device = await openDeck(lib);
      if (!device) {
        log('no Stream Deck found; retrying');
      } else {
        await device.deck.clearPanel?.();
        const why = await runSession({ device, sharp });
        log(`session ended: ${why}`);
      }
    } catch (e) {
      log(e?.message ?? e);
    } finally {
      try { await device?.deck.close(); } catch {}
    }
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
