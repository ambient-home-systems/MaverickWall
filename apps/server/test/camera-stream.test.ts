import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
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
import { createFrameParser } from '../src/modules/cameras/frames.js';
import { createCameraHub, HUB_LIMITS } from '../src/modules/cameras/hub.js';
import { CAMERA_BOUNDARY } from '../src/modules/cameras/multipart.js';
import { watchCamera } from '../src/modules/cameras/index.js';
import { CAMERA_FRAMES, TOKEN, closeFakeHomeAssistants, fakeHomeAssistant, type FakeHa } from './fake-home-assistant.js';

/**
 * A camera's live stream (plan item M6.2, RFC 007 §5 and §11), against the
 * real app, the real fetcher and a stand-in Home Assistant that streams real
 * JPEG frames the way core's MJPEG loop does — never a stub, because a mocked
 * stream passes over every timeout and every backpressure fault.
 *
 * What is proven: one socket into the house however many walls watch; a wall
 * that stops reading holds back nobody; a quiet camera is reopened without the
 * wall being told; the last wall leaving closes the socket after the grace
 * and not before; a wall revoked loses its picture within a second or two; a
 * snapshot of a streaming camera costs the house nothing; and a stream
 * redirect is never followed with the house's token.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
const servers: Server[] = [];
let n = 0;
const DOOR = 'camera.front_door';

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  for (const server of servers) server.close();
  await closeFakeHomeAssistants();
});

const until = async (what: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

interface Harness {
  readonly db: SqliteDatabase;
  readonly ha: FakeHa;
  readonly handle: string;
  readonly wall: (screen: string, path: string) => Promise<Response>;
}

async function harness(limits: Partial<typeof HUB_LIMITS> = {}): Promise<Harness> {
  n++;
  const ha = await fakeHomeAssistant();
  ha.cameras[DOOR] = { state: 'idle', name: 'Front door' };
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-stream-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(stamp, stamp);
  const keyring = createKeyring(randomBytes(32));
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'a'.repeat(32), baseUrl: 'http://localhost' },
    keyring,
    fetcher: createFetcher(),
    clientAddress: () => `10.62.${n}.1`,
    setupToken,
    dataDir,
    cameraHubLimits: { graceMs: 300, idleMs: 600, backoffMs: [50, 50, 50], ...limits },
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
    admin(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  await admin(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', { name: 'Household', email: `stream${n}@home.local`, password: 'correct-horse-battery', confirm: 'correct-horse-battery' });
  await form('/setup/household', { timezone: 'Europe/London' });
  await form('/admin/home-assistant/connect', { base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1' });
  const added = watchCamera(db, { entityId: DOOR, name: 'Front door' }, stamp);
  if (!added.ok) throw new Error(added.message);
  const tokens = new Map<string, string>();
  for (const id of ['kitchen', 'hall']) {
    const display = issueDisplayToken();
    tokens.set(id, display.token);
    db.prepare(
      `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, layout_mode, created_at, updated_at)
       VALUES (?, ?, ?, 'panels', ?, 'freeform', ?, ?)`,
    ).run(id, id, display.tokenHash, stamp, stamp, stamp);
    db.prepare(
      `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
       VALUES (?, ?, 'portrait', 'camera', 0, 0, 0.5, 0.5, 0, ?, ?, ?)`,
    ).run(`cam-${id}`, id, JSON.stringify({ camera: added.handle, cameraMode: 'stream' }), stamp, stamp);
  }
  return {
    db,
    ha,
    handle: added.handle,
    wall: async (screen, path) =>
      app.fetch(new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${tokens.get(screen) ?? ''}` } })),
  };
}

/** Read whole frames off a stream response as they come, until told to stop. */
function frames(response: Response): { readonly got: Uint8Array[]; readonly done: Promise<void>; stop(): Promise<void> } {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const parser = createFrameParser(4 * 1024 * 1024);
  const got: Uint8Array[] = [];
  let stopped = false;
  const done = (async (): Promise<void> => {
    for (;;) {
      const { value, done: ended } = await reader.read();
      if (ended || stopped) return;
      got.push(...parser.push(value));
    }
  })();
  return {
    got,
    done,
    async stop(): Promise<void> {
      stopped = true;
      await reader.cancel();
    },
  };
}

const sameAs = (frame: Uint8Array | undefined, want: Buffer): boolean => frame !== undefined && Buffer.from(frame).equals(want);

describe('a camera’s live stream', () => {
  it('re-serves whole frames under its own boundary, never cached, from one socket for every wall', async () => {
    const h = await harness();
    const kitchen = await h.wall('kitchen', `/d/camera/${h.handle}/stream`);
    expect(kitchen.status).toBe(200);
    expect(kitchen.headers.get('content-type')).toBe('multipart/x-mixed-replace; boundary=mw-camera-frame');
    expect(kitchen.headers.get('cache-control')).toBe('no-store');
    const k = frames(kitchen);
    await until(() => k.got.length >= 3);
    // Whole frames, exactly the camera's, in order (the first sent twice by core).
    expect(sameAs(k.got[0], CAMERA_FRAMES.a)).toBe(true);
    expect(k.got.some((frame) => sameAs(frame, CAMERA_FRAMES.b))).toBe(true);
    // The house's token went to the house, on the stream path and nothing else.
    expect(h.ha.paths).toContain(`/api/camera_proxy_stream/${DOOR}`);
    expect(h.ha.seen).toContain(`Bearer ${TOKEN}`);

    // A second wall joins the same socket, and is handed a frame at once.
    const hall = frames(await h.wall('hall', `/d/camera/${h.handle}/stream`));
    await until(() => hall.got.length >= 2);
    expect(h.ha.streamOpens).toBe(1);

    // A snapshot of a camera that is streaming is its latest frame, and costs the house nothing.
    const before = h.ha.paths.filter((path) => path.startsWith('/api/camera_proxy/')).length;
    const still = await h.wall('kitchen', `/d/camera/${h.handle}/still`);
    expect(still.status).toBe(200);
    expect(still.headers.get('content-type')).toBe('image/jpeg');
    expect(h.ha.paths.filter((path) => path.startsWith('/api/camera_proxy/')).length).toBe(before);

    await k.stop();
    await hall.stop();
  });

  it('keeps a fast wall flowing while another reads nothing, on one socket', async () => {
    const h = await harness();
    // The hall opens a stream and never reads a byte of it.
    const stalled = await h.wall('hall', `/d/camera/${h.handle}/stream`);
    expect(stalled.status).toBe(200);
    const k = frames(await h.wall('kitchen', `/d/camera/${h.handle}/stream`));
    await until(() => k.got.length >= 8);
    expect(h.ha.streamOpens).toBe(1);
    await k.stop();
    await stalled.body?.cancel();
  });

  it('closes the socket into the house a grace period after the last wall leaves, and not before', async () => {
    const h = await harness();
    const first = frames(await h.wall('kitchen', `/d/camera/${h.handle}/stream`));
    await until(() => first.got.length >= 2);
    await first.stop();
    // Back inside the grace, as a reloading wall is: the same socket.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const again = frames(await h.wall('kitchen', `/d/camera/${h.handle}/stream`));
    await until(() => again.got.length >= 2);
    expect(h.ha.streamOpens).toBe(1);
    await again.stop();
    await until(() => h.ha.streamsOpen === 0, 3_000);
    expect(h.ha.streamOpens).toBe(1);
  });

  it('reopens a camera that goes quiet without telling the wall', async () => {
    const h = await harness();
    const k = frames(await h.wall('kitchen', `/d/camera/${h.handle}/stream`));
    await until(() => k.got.length >= 2);
    h.ha.streamQuiet = true;
    await until(() => h.ha.streamOpens >= 2, 5_000);
    h.ha.streamQuiet = false;
    const seen = k.got.length;
    await until(() => k.got.length > seen + 2, 5_000);
    // The wall's one response carried on across the reopen.
    let ended = false;
    void k.done.then(() => {
      ended = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ended).toBe(false);
    await k.stop();
  });

  it('ends a wall’s stream within two seconds of the wall being revoked', async () => {
    const h = await harness();
    const k = frames(await h.wall('kitchen', `/d/camera/${h.handle}/stream`));
    await until(() => k.got.length >= 2);
    h.db.prepare('UPDATE screens SET revoked_at = ? WHERE id = ?').run(Date.now(), 'kitchen');
    const started = Date.now();
    await k.done;
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it('ends the stream after several opens fail in a row, which is when the wall shows its placeholder', async () => {
    const h = await harness();
    h.ha.cameraFails = true;
    const k = frames(await h.wall('kitchen', `/d/camera/${h.handle}/stream`));
    await k.done;
    expect(k.got).toEqual([]);
  });

  it('refuses a wall it is not placed on, a camera that is missing, and a wall at its limit — each with a sentence', async () => {
    const h = await harness({ perScreen: 1 });
    h.db.prepare(`DELETE FROM layout_widgets WHERE screen_id = 'hall'`).run();
    expect((await h.wall('hall', `/d/camera/${h.handle}/stream`)).status).toBe(404);

    const one = frames(await h.wall('kitchen', `/d/camera/${h.handle}/stream`));
    await until(() => one.got.length >= 1);
    const second = await h.wall('kitchen', `/d/camera/${h.handle}/stream`);
    expect(second.status).toBe(503);
    expect(await second.text()).toContain('as many live cameras as it can');
    await one.stop();

    h.db.prepare('UPDATE ha_cameras SET available = 0').run();
    const missing = await h.wall('kitchen', `/d/camera/${h.handle}/stream`);
    expect(missing.status).toBe(503);
    expect(await missing.text()).not.toContain(DOOR);
  });
});

describe('the hub', () => {
  it('drops a source whose frame is over the cap, and ends after it keeps doing so', async () => {
    let opens = 0;
    const hub = createCameraHub(
      async () => {
        opens += 1;
        return {
          ok: true,
          chunks: (async function* (): AsyncGenerator<Uint8Array> {
            yield new Uint8Array(CAMERA_FRAMES.a);
          })(),
          close: () => undefined,
        };
      },
      { ...HUB_LIMITS, frameBytes: 1_000, backoffMs: [10], failuresBeforeEnding: 3 },
    );
    const subscribed = hub.subscribe('h', 's');
    if (!subscribed.ok) throw new Error('refused');
    expect(await subscribed.subscription.next()).toBeUndefined();
    expect(opens).toBe(3);
  });
});

describe('the boundary', () => {
  it('is the one the wall reads frames by', () => {
    const display = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'display', 'src', 'camera.ts'), 'utf8');
    expect(display).toContain(`export const CAMERA_BOUNDARY = '${CAMERA_BOUNDARY}';`);
  });
});

describe('the stream fetch', () => {
  it('never follows a redirect, so the token cannot be carried anywhere', async () => {
    let elsewhere = 0;
    const other = createServer((_req, res) => {
      elsewhere += 1;
      res.end();
    });
    const redirecting = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${(other.address() as { port: number }).port}/` });
      res.end();
    });
    servers.push(other, redirecting);
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', () => resolve()));
    await new Promise<void>((resolve) => redirecting.listen(0, '127.0.0.1', () => resolve()));
    const fetcher = createFetcher();
    const outcome = await fetcher.stream?.({
      url: `http://127.0.0.1:${(redirecting.address() as { port: number }).port}/api/camera_proxy_stream/camera.x`,
      policy: { allowLoopback: true, allowHttp: true },
      headers: { authorization: 'Bearer secret' },
      acceptContentTypes: ['multipart/x-mixed-replace'],
    });
    expect(outcome?.status).toBe('rejected');
    expect(elsewhere).toBe(0);
  });

  it('refuses an answer that is not a stream, and an address the guard refuses', async () => {
    const plain = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<p>login</p>');
    });
    servers.push(plain);
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', () => resolve()));
    const fetcher = createFetcher();
    const port = (plain.address() as { port: number }).port;
    const html = await fetcher.stream?.({
      url: `http://127.0.0.1:${port}/`,
      policy: { allowLoopback: true, allowHttp: true },
      acceptContentTypes: ['multipart/x-mixed-replace'],
    });
    expect(html?.status).toBe('failed');
    const refused = await fetcher.stream?.({
      url: `http://127.0.0.1:${port}/`,
      policy: {},
      acceptContentTypes: ['multipart/x-mixed-replace'],
    });
    expect(refused?.status).toBe('rejected');
  });
});
