import { afterAll, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { issueDisplayToken } from '../src/auth/tokens.js';
import { seedDefaultRules } from '../src/api/rules.js';
import { type CapAlert } from '../src/modules/weather/alerts.js';
import { applyAlerts } from '../src/modules/weather/alert-store.js';
import { readScreens } from '../src/api/queries.js';
import { manifestEtag, type Manifest } from '../src/api/manifest.js';
import { PushHub, PUSH_PATH } from '../src/net/push-hub.js';
import type { ScreenRow } from '../src/api/queries.js';

/**
 * The self-hosted push channel, driven over a real socket.
 *
 * This is the "not started: ws push" item, and the repo's doctrine is why it
 * is tested this way rather than against a stub: a real Node server, a real
 * display token on the wire, a real Extreme alert seeded into the database and
 * evaluated through the very same manifest builder a poll uses — then the
 * wake-bearing message asserted as it actually arrives. A mock socket or a
 * hand-rolled interrupt would prove the transport and the domain agree with
 * themselves, which is exactly the shape of bug that ships green.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
const servers: ServerType[] = [];
const hubs: PushHub[] = [];
const sockets: WebSocket[] = [];

afterAll(async () => {
  for (const ws of sockets) ws.close();
  for (const hub of hubs) hub.close();
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** An Extreme Tornado Warning, shaped as `applyAlerts` stores it, live for an hour. */
function tornadoWarning(): CapAlert {
  return {
    id: `urn:oid:tornado-${randomBytes(4).toString('hex')}`,
    sent: new Date().toISOString(),
    messageType: 'Alert',
    references: [],
    event: 'Tornado Warning',
    headline: 'Tornado Warning issued by NWS',
    description: 'A tornado was detected.',
    instruction: 'TAKE COVER NOW. Move to an interior room on the lowest floor.',
    areaDesc: 'Howard, MD',
    senderName: 'NWS Baltimore/Washington',
    severity: 'Extreme',
    urgency: 'Immediate',
    certainty: 'Observed',
    onsetAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
    zoneCode: 'MDC027',
  };
}

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-push-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  /*
   * With a location, because a weather rule with nowhere to watch is not armed
   * (RFC 009 Phase 2) — and a household with a tornado warning in force
   * demonstrably has one. Without it the shipped ladder is inert, which is the
   * point of that change and would make every assertion below vacuous.
   */
  db.prepare(
    `INSERT INTO household_settings (id, latitude, longitude, created_at, updated_at)
     VALUES ('singleton', 39.2, -76.8, ?, ?)`,
  ).run(stamp, stamp);
  seedDefaultRules(db);

  // A paired screen with a token we hold. The token is the display credential
  // the socket presents — exactly what the wall uses to poll.
  const issued = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
     VALUES ('s1', 'Kitchen', ?, ?, ?, ?)`,
  ).run(issued.tokenHash, stamp, stamp, stamp);

  let build: ((screen: ScreenRow) => Manifest) | undefined;
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'p'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    dataDir,
    setupToken: createSetupTokenHolder(() => {}),
    onManifestBuilder: (b) => {
      build = b;
    },
  });

  const hub = new PushHub({
    screens: () => readScreens(db),
    evaluate: (screen) => {
      const manifest = build!(screen);
      return { etag: manifestEtag(manifest), interrupts: manifest.interrupts };
    },
  });
  hubs.push(hub);

  // A real server on an ephemeral port, wired exactly as boot wires it.
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  servers.push(server);
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === PUSH_PATH) hub.handleUpgrade(request, socket, head);
    else socket.destroy();
  });

  const port = await new Promise<number>((resolve) => {
    server.on('listening', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });

  return { db, hub, token: issued.token, url: `ws://127.0.0.1:${port}${PUSH_PATH}` };
}

/** The next message off a socket, parsed, or a timeout. */
function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no message within timeout')), timeoutMs);
    ws.once('message', (data: Buffer) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

function connect(url: string, token?: string): WebSocket {
  const ws =
    token === undefined
      ? new WebSocket(url)
      : new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  sockets.push(ws);
  return ws;
}

describe('the WebSocket push channel', () => {
  it('refuses a socket with no display token', async () => {
    const h = await harness();
    const status = await new Promise<number>((resolve, reject) => {
      const ws = connect(h.url); // no token
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => reject(new Error('an unauthenticated socket was accepted')));
      // ws surfaces a non-101 as an error too; the status is what we assert on.
      ws.on('error', () => {
        /* expected — the unexpected-response handler carries the verdict */
      });
    });
    expect(status).toBe(401);
    expect(h.hub.size).toBe(0);
  });

  it('greets a paired screen with the interrupts in force', async () => {
    const h = await harness();
    // A tornado is already overhead when the wall connects — as after a power
    // cut. It must learn immediately, not after the first tick or first poll.
    applyAlerts(h.db, [tornadoWarning()], []);

    const ws = connect(h.url, h.token);
    const message = await nextMessage(ws);

    expect(message['type']).toBe('INTERRUPT_PUSH');
    expect(message['wakeScreen']).toBe(true);
    const interrupts = message['interrupts'] as { title: string }[];
    expect(interrupts.length).toBeGreaterThanOrEqual(1);
    expect(interrupts[0]?.title).toContain('Tornado');
  });

  it('pushes a new warning to a connected screen on the next tick', async () => {
    const h = await harness();
    const ws = connect(h.url, h.token);

    // The greeting: nothing in force, so no wake.
    const greeting = await nextMessage(ws);
    expect(greeting['type']).toBe('INTERRUPT_PUSH');
    expect(greeting['wakeScreen']).toBe(false);

    // The storm arrives, and a tick carries it — the latency this socket exists
    // to erase. The test owns the tick; boot owns the interval.
    applyAlerts(h.db, [tornadoWarning()], []);
    const delivered = nextMessage(ws);
    h.hub.tick();

    const message = await delivered;
    expect(message['type']).toBe('INTERRUPT_PUSH');
    expect(message['wakeScreen']).toBe(true);
  });

  it('sends nothing on a tick when nothing changed', async () => {
    const h = await harness();
    const ws = connect(h.url, h.token);
    await nextMessage(ws); // the greeting

    // A tick over an unchanged wall must be silent — otherwise every screen
    // re-polls every five seconds for no reason.
    h.hub.tick();
    await expect(nextMessage(ws, 500)).rejects.toThrow('no message within timeout');
  });
});
