// Local link between the Flightdeck worker and the deck helper.
// Newline-delimited JSON over TCP on 127.0.0.1. The worker listens on a port the system picks and
// writes {port, token} to a file only this user can read; a client's first line must carry that
// token. A web page can reach a loopback port but cannot read the file, so it cannot get in.
// (Pairing approach adapted from crilofer/orca-streamdeck, MIT.)
import { createServer } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DECK_PROTOCOL = 1;

export function rendezvousPath() {
  return process.env.FLIGHTDECK_DECK_FILE || join(homedir(), '.flightdeck', 'deck.json');
}

export function readRendezvous(path = rendezvousPath()) {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return Number.isInteger(v.port) && typeof v.token === 'string' ? v : null;
  } catch {
    return null;
  }
}

function sameToken(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// onClient(client) → client.send(msg), client.close(); onMessage(client, msg)
export function startBridge({ onMessage, onConnect, onDisconnect, log = () => {}, path = rendezvousPath() } = {}) {
  const token = randomBytes(24).toString('hex');
  const clients = new Set();

  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let authed = false;
    let buf = '';
    const client = {
      info: null,
      send(msg) {
        if (authed && !socket.destroyed) socket.write(JSON.stringify(msg) + '\n');
      },
      close() {
        socket.destroy();
      }
    };
    socket.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 1_000_000) return socket.destroy();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return socket.destroy();
        }
        if (!authed) {
          if (msg?.type !== 'auth' || !sameToken(msg.token, token)) return socket.destroy();
          authed = true;
          clients.add(client);
          client.send({ type: 'hello', protocol: DECK_PROTOCOL });
          onConnect?.(client);
          continue;
        }
        try {
          onMessage?.(client, msg);
        } catch (e) {
          log(`deck bridge: handler failed: ${e?.message ?? e}`);
        }
      }
    });
    socket.on('close', () => {
      if (clients.delete(client)) onDisconnect?.(client);
    });
    socket.on('error', () => {});
  });

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, JSON.stringify({ port, token }) + '\n', { mode: 0o600 });
        chmodSync(path, 0o600);
      } catch (e) {
        log(`deck bridge: could not write ${path}: ${e?.message ?? e}`);
      }
      log(`deck bridge: listening on 127.0.0.1:${port}`);
      resolve(port);
    });
  });
  server.unref?.();

  return {
    ready,
    token,
    get clientCount() {
      return clients.size;
    },
    broadcast(msg) {
      for (const c of clients) c.send(msg);
    },
    stop() {
      for (const c of clients) c.close();
      server.close();
      if (readRendezvous(path)?.token === token) rmSync(path, { force: true });
    }
  };
}
