import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { issueDisplayToken } from '../src/auth/tokens.js';
import { haModule } from '../src/modules/homeassistant/index.js';
import { serve, type ServerType } from '@hono/node-server';
import { WebSocket } from 'ws';
import { wirePush, type PushWiring } from '../src/net/push-wire.js';
import type { ScreenRow } from '../src/api/queries.js';
import type { Manifest } from '../src/api/manifest.js';
import { entitiesIn, liveEntities, startHaLive, type LiveHandle, type LiveTimings } from '../src/modules/homeassistant/live.js';
import { TOKEN, closeFakeHomeAssistants, fakeHomeAssistant, type FakeHa } from './fake-home-assistant.js';

/**
 * Home Assistant, heard as it happens: a doorbell rung reaches the manifest
 * in about a second, where the poll alone took up to thirty.
 *
 * Against the real app, the real fetcher — whose held socket is the one under
 * test — and a stand-in Home Assistant that speaks `subscribe_entities` the
 * way core does: a result, the named entities' states, then a change event
 * each time one moves. Nothing here calls the poll: every read the manifest
 * shows was run by the subscription.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
const handles: LiveHandle[] = [];
const servers: { push: PushWiring; server: ServerType }[] = [];
let n = 0;
const BELL = 'event.front_door_ring';

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.close();
  for (const { push, server } of servers.splice(0)) {
    push.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await closeFakeHomeAssistants();
});

const until = async (what: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await what())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  readonly db: SqliteDatabase;
  readonly keyring: ReturnType<typeof createKeyring>;
  readonly ha: FakeHa;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly interrupts: () => Promise<{ action: string; title: string }[]>;
  /** How many reads the subscription has run, and how many times it told the walls. */
  readonly counts: { reads: number; changed: number; opens: number };
  readonly listen: (timings?: Partial<LiveTimings>) => LiveHandle;
  readonly ring: () => void;
  /** A wall's push socket, on a real server with the push timer at a minute: only a nudge reaches it. */
  readonly pushSocket: () => Promise<{ messages: string[] }>;
}

async function harness(): Promise<Harness> {
  n++;
  const ha = await fakeHomeAssistant();
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-ha-live-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(stamp, stamp);
  const keyring = createKeyring(randomBytes(32));
  const fetcher = createFetcher();
  const setupToken = createSetupTokenHolder(() => {});
  let push: PushWiring | undefined;
  let build: ((screen: ScreenRow) => Manifest) | undefined;
  const app = createApp({
    onWrite: () => push?.nudge(),
    onManifestBuilder: (made) => {
      build = made;
    },
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'a'.repeat(32), baseUrl: 'http://localhost' },
    keyring,
    fetcher,
    clientAddress: () => `10.64.${n}.1`,
    setupToken,
    dataDir,
  });
  const jar = new Map<string, string>();
  const admin = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie !== '') headers.set('cookie', cookie);
    const response = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return response;
  };
  const form = (path: string, fields: Record<string, string>): Promise<Response> =>
    admin(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  await admin(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', {
    name: 'Household',
    email: `live${n}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });
  await form('/admin/home-assistant/connect', { base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1' });
  // The ring before this one, an hour ago: history, not a visitor.
  ha.others[BELL] = { state: new Date(stamp - 3_600_000).toISOString(), name: 'Front door ring' };
  const saved = await form('/admin/home-assistant/rules', {
    name: 'Somebody at the door',
    entity_id: BELL,
    condition: 'happened',
    value: '',
    action: 'takeover',
    hold_sec: '60',
    camera: '',
  });
  if (saved.status !== 302) throw new Error(`rule not saved: ${saved.status}`);

  const wall = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, layout_mode, created_at, updated_at)
     VALUES ('kitchen', 'Kitchen', ?, 'panels', ?, 'freeform', ?, ?)`,
  ).run(wall.tokenHash, stamp, stamp, stamp);

  const counts = { reads: 0, changed: 0, opens: 0 };
  return {
    db,
    keyring,
    ha,
    form,
    counts,
    interrupts: async () => {
      const response = await app.fetch(
        new Request('http://localhost/d/manifest', { headers: { authorization: `Bearer ${wall.token}` } }),
      );
      return ((await response.json()) as { interrupts: { action: string; title: string }[] }).interrupts;
    },
    listen: (timings = {}) => {
      const counting = {
        ...fetcher,
        subscribe: (request: Parameters<NonNullable<typeof fetcher.subscribe>>[0]) => {
          counts.opens++;
          return (fetcher.subscribe as NonNullable<typeof fetcher.subscribe>)(request);
        },
      };
      const handle = startHaLive({
        db,
        fetcher: counting,
        keyring,
        sync: async () => {
          counts.reads++;
          await (haModule.job as { run: (c: unknown) => Promise<void> }).run({
            db,
            fetcher,
            keyring,
            now: Date.now(),
            timezone: 'Europe/London',
          });
        },
        changed: () => {
          counts.changed++;
          push?.nudge();
        },
        timings,
        env: {},
      });
      handles.push(handle);
      return handle;
    },
    pushSocket: async () => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
      const port = await new Promise<number>((resolve) =>
        server.on('listening', () => resolve((server.address() as { port: number }).port)),
      );
      push = wirePush(server, { db, build: () => build, tickMs: 60_000 });
      servers.push({ push, server });
      const ws = new WebSocket(`ws://127.0.0.1:${port}/d/push`, { headers: { authorization: `Bearer ${wall.token}` } });
      const messages: string[] = [];
      ws.on('message', (data) => messages.push(data.toString()));
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });
      return { messages };
    },
    ring: () => {
      const at = new Date().toISOString();
      ha.others[BELL] = { state: at, name: 'Front door ring' };
      ha.emit(BELL, at);
    },
  };
}

describe('a doorbell, heard as it rings', () => {
  it('reaches the manifest in about a second, with no poll run', async () => {
    const h = await harness();
    const live = h.listen();
    await until(() => live.listening);
    // The read the subscription runs on opening — anything missed while it was down.
    await until(() => h.counts.reads >= 1 && h.counts.changed >= 1);
    expect(await h.interrupts()).toEqual([]);

    const rang = Date.now();
    h.ring();
    let heard = 0;
    await until(async () => {
      const up = (await h.interrupts()).some((interrupt) => interrupt.action === 'takeover');
      if (up) heard = Date.now() - rang;
      return up;
    }, 5_000);
    // A quarter of a second's gathering, one read of the stand-in, and the
    // manifest: well under the poll's thirty.
    expect(heard).toBeLessThan(1_500);
    expect(h.counts.changed).toBeGreaterThanOrEqual(2);
  });

  it('reaches a wall on the push channel in about a second, with the push timer at a minute', async () => {
    const h = await harness();
    const socket = await h.pushSocket();
    const live = h.listen();
    await until(() => live.listening);
    await until(() => h.counts.changed >= 1);
    await sleep(500);
    const before = socket.messages.length;
    const rang = Date.now();
    h.ring();
    await until(() => socket.messages.slice(before).some((text) => text.includes('INTERRUPT_PUSH')), 5_000);
    expect(Date.now() - rang).toBeLessThan(1_500);
  });

  it('asks for the entities it needs and says nothing but the token, the subscription and a ping', async () => {
    const h = await harness();
    h.db
      .prepare(
        `INSERT INTO ha_entity_cache (entity_id, label, display_mode, sort_order, watched, fetched_at)
         VALUES ('sensor.kitchen_temperature', 'Kitchen', 'label_value', 0, 1, 0)`,
      )
      .run();
    const live = h.listen({ pingMs: 100 });
    await until(() => live.listening);
    await until(() => h.ha.wsReceived.filter((text) => text.includes('"ping"')).length >= 2);
    const types = new Set(h.ha.wsReceived.map((text) => (JSON.parse(text) as { type: string }).type));
    expect([...types].sort()).toEqual(['auth', 'ping', 'subscribe_entities']);
    expect(h.ha.subscriptions.map((s) => s.entityIds)).toEqual([[BELL, 'sensor.kitchen_temperature']]);
    // The token is said once, in the handshake, and in no later message.
    expect(h.ha.wsReceived.filter((text) => text.includes(TOKEN))).toHaveLength(1);
  });

  it('subscribes again when a rule names a new entity', async () => {
    const h = await harness();
    const live = h.listen({ pingMs: 100 });
    await until(() => live.listening);
    expect(h.ha.subscriptions.map((s) => s.entityIds)).toEqual([[BELL]]);
    await h.form('/admin/home-assistant/rules', {
      name: 'Back door',
      entity_id: 'binary_sensor.back_door',
      condition: 'equals',
      value: 'on',
      action: 'banner',
      hold_sec: '',
      camera: '',
    });
    await until(() =>
      h.ha.subscriptions.some((s) => s.entityIds.includes('binary_sensor.back_door') && s.entityIds.includes(BELL)),
    );
    // The old subscription is gone: one socket, one list.
    await until(() => h.ha.subscriptions.length === 1);
  });

  it('comes back after Home Assistant restarts, and the next ring is heard', async () => {
    const h = await harness();
    const live = h.listen({ backoffMinMs: 50 });
    await until(() => live.listening);
    h.ha.dropSockets();
    await until(() => !live.listening);
    await until(() => live.listening);
    const rang = Date.now();
    h.ring();
    await until(async () => (await h.interrupts()).some((interrupt) => interrupt.action === 'takeover'));
    expect(Date.now() - rang).toBeLessThan(1_500);
  });

  it('runs no reads for a reading that changes, sooner than the reading gap', async () => {
    const h = await harness();
    h.db
      .prepare(
        `INSERT INTO ha_entity_cache (entity_id, label, display_mode, sort_order, watched, fetched_at)
         VALUES ('sensor.kitchen_temperature', 'Kitchen', 'label_value', 0, 1, 0)`,
      )
      .run();
    const live = h.listen({ readingGapMs: 1_500 });
    await until(() => live.listening);
    await until(() => h.counts.reads >= 1);
    await sleep(100);
    const before = h.counts.reads;
    // A chatty sensor: five changes in half a second cost no read inside the gap...
    for (let i = 0; i < 5; i++) {
      h.ha.emit('sensor.kitchen_temperature', String(19 + i / 10));
      await sleep(100);
    }
    expect(h.counts.reads).toBe(before);
    // ...and one read after it, for all five.
    await until(() => h.counts.reads === before + 1, 3_000);
    await sleep(300);
    expect(h.counts.reads).toBe(before + 1);
    // While a ring in the middle of that is read at once.
    h.ha.emit('sensor.kitchen_temperature', '21');
    const now = h.counts.reads;
    h.ring();
    await until(() => h.counts.reads === now + 1, 600);
  });

  it('leaves the poll to answer when Home Assistant will not subscribe, and backs off', async () => {
    const h = await harness();
    h.ha.refuseSubscribe = true;
    const live = h.listen({ backoffMinMs: 100, backoffMaxMs: 400 });
    await sleep(1_200);
    expect(live.listening).toBe(false);
    // 100, 200, 400, 400 ms between tries: a handful, never a spin.
    const tries = h.ha.wsReceived.filter((text) => text.includes('subscribe_entities')).length;
    expect(tries).toBeGreaterThanOrEqual(2);
    expect(tries).toBeLessThanOrEqual(6);
    expect(h.counts.reads).toBe(0);
  });

  it('backs off when the socket will not open at all', async () => {
    const h = await harness();
    h.ha.down = true;
    const live = h.listen({ backoffMinMs: 100, backoffMaxMs: 400 });
    await sleep(1_200);
    expect(live.listening).toBe(false);
    expect(h.counts.opens).toBeGreaterThanOrEqual(2);
    expect(h.counts.opens).toBeLessThanOrEqual(6);
  });

  it('reads at once for a rule about a reading, not after the reading gap', async () => {
    const h = await harness();
    await h.form('/admin/home-assistant/rules', {
      name: 'Back door',
      entity_id: 'binary_sensor.back_door',
      condition: 'equals',
      value: 'on',
      action: 'banner',
      hold_sec: '',
      camera: '',
    });
    const live = h.listen({ readingGapMs: 5_000 });
    await until(() => live.listening);
    await until(() => h.counts.reads >= 1);
    await sleep(100);
    const before = h.counts.reads;
    h.ha.emit('binary_sensor.back_door', 'on');
    await until(() => h.counts.reads === before + 1, 600);
  });

  it('opens no socket for a house with nothing to watch', async () => {
    const h = await harness();
    h.db.prepare('DELETE FROM interrupt_rules').run();
    expect(liveEntities(h.db).urgent.size + liveEntities(h.db).readings.size).toBe(0);
    h.listen({ recheckMs: 50 });
    await sleep(300);
    expect(h.ha.wsReceived).toEqual([]);
  });
});

describe('two reads at once', () => {
  it('run one after the other, so the older answer is never written last', async () => {
    const h = await harness();
    h.db
      .prepare(
        `INSERT INTO ha_entity_cache (entity_id, label, display_mode, sort_order, watched, fetched_at)
         VALUES ('sensor.kitchen_temperature', 'Kitchen', 'label_value', 0, 1, 0)`,
      )
      .run();
    const real = createFetcher();
    let asked = 0;
    // The first read is answered with the old temperature, and slowly; the
    // second, asked meanwhile, with the new one at once.
    const slow = {
      ...real,
      fetch: async (request: Parameters<typeof real.fetch>[0]) => {
        if (!request.url.endsWith('/api/states')) return real.fetch(request);
        asked++;
        const out = await real.fetch(request);
        if (asked === 1) await sleep(300);
        return out;
      },
    };
    const run = (now: number): Promise<void> =>
      (haModule.job as { run: (c: unknown) => Promise<void> }).run({
        db: h.db,
        fetcher: slow,
        keyring: h.keyring,
        now,
        timezone: 'Europe/London',
      });
    h.ha.kitchen = '18.0';
    const first = run(Date.now());
    await sleep(50);
    h.ha.kitchen = '21.5';
    const second = run(Date.now());
    await Promise.all([first, second]);
    expect(h.db.prepare(`SELECT state FROM ha_entity_cache WHERE entity_id = 'sensor.kitchen_temperature'`).get()).toEqual({
      state: '21.5',
    });
  });
});

describe('entitiesIn', () => {
  it('names the entities added, changed and removed, and nothing else', () => {
    expect(entitiesIn({ a: { 'light.a': { s: 'on' } }, c: { 'sensor.b': { '+': { s: '1' } } }, r: ['switch.c', 3] })).toEqual([
      'light.a',
      'sensor.b',
      'switch.c',
    ]);
    expect(entitiesIn(undefined)).toEqual([]);
    expect(entitiesIn({ a: ['not', 'a', 'map'] })).toEqual([]);
  });
});

describe('the held socket', () => {
  const open = async (): Promise<{ port: number; sockets: WebSocketServer; close: () => Promise<void> }> => {
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      port: (server.address() as { port: number }).port,
      sockets,
      close: async () => {
        for (const client of sockets.clients) client.terminate();
        sockets.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  };
  const LOCAL = { allowHttp: true, allowLoopback: true, allowPrivateNetwork: true };

  it('refuses a loopback address it was not allowed, before anything is sent', async () => {
    const s = await open();
    let connected = false;
    s.sockets.on('connection', () => {
      connected = true;
    });
    const refused = await createFetcher().subscribe?.({
      url: `http://127.0.0.1:${s.port}/`,
      policy: { allowHttp: true },
      maxBytes: 1000,
      idleTimeoutMs: 1000,
      converse: () => ({ send: [] }),
    });
    expect(refused?.status).toBe('rejected');
    expect(connected).toBe(false);
    await s.close();
  });

  it('ends on a message over the ceiling, and on silence', async () => {
    const s = await open();
    s.sockets.on('connection', (ws) => ws.send('x'.repeat(5000)));
    const big = await createFetcher().subscribe?.({
      url: `http://127.0.0.1:${s.port}/`,
      policy: LOCAL,
      maxBytes: 1000,
      idleTimeoutMs: 5000,
      converse: () => ({ send: [] }),
    });
    expect(big?.status).toBe('ok');
    if (big?.status !== 'ok') return;
    expect((await big.ended).code).toBe('too-large');
    s.sockets.removeAllListeners('connection');
    const quiet = await createFetcher().subscribe?.({
      url: `http://127.0.0.1:${s.port}/`,
      policy: LOCAL,
      maxBytes: 1000,
      idleTimeoutMs: 200,
      converse: () => ({ send: [] }),
    });
    expect(quiet?.status).toBe('ok');
    if (quiet?.status !== 'ok') return;
    const began = Date.now();
    expect((await quiet.ended).code).toBe('timeout');
    expect(Date.now() - began).toBeLessThan(1_000);
    await s.close();
  });

  it('follows no redirect', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(302, { location: 'http://127.0.0.1:1/' });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const outcome = await createFetcher().subscribe?.({
      url: `http://127.0.0.1:${port}/`,
      policy: LOCAL,
      maxBytes: 1000,
      idleTimeoutMs: 1000,
      converse: () => ({ send: [] }),
    });
    expect(outcome?.status).toBe('rejected');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('what the subscription may say', () => {
  it('sends the token and its two commands, and no other message type', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'modules', 'homeassistant', 'live.ts'), 'utf8');
    const sent = [...source.matchAll(/JSON\.stringify\(\{[^}]*type: '([a-z_/]+)'/g)].map((match) => match[1]);
    expect([...new Set(sent)].sort()).toEqual(['auth', 'ping', 'subscribe_entities']);
    // And nothing reaches the house any other way from here.
    expect(source).not.toMatch(/postJson|callService|\.fetch\(/);
  });
});
