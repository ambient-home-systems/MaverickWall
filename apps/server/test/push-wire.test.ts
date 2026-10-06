import { afterAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { wirePush } from '../src/net/push-wire.js';

/**
 * The two ways a wall hears of a change (plan item M1.1): the app saying a
 * write went through, and the wiring turning a burst of those into one tick.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
const servers: Server[] = [];

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function database() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-pushwire-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  return { db, dataDir };
}

describe('the app tells the push channel about writes', () => {
  it('after a write that went through, and never after a read or a refused one', async () => {
    const { db, dataDir } = database();
    const stamp = Date.now();
    db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(stamp, stamp);
    let writes = 0;
    const setupToken = createSetupTokenHolder(() => {});
    const app = createApp({
      db,
      appVersion: '0.1.0-test',
      bootNotices: [],
      auth: { secret: 'h'.repeat(32), baseUrl: 'http://localhost' },
      keyring: createKeyring(randomBytes(32)),
      fetcher: createFetcher(),
      clientAddress: () => '10.19.0.1',
      setupToken,
      dataDir,
      onWrite: () => {
        writes += 1;
      },
    });
    const get = await app.fetch(new Request(`http://localhost/setup?token=${setupToken.current().token}`));
    expect(get.status).toBeLessThan(400);
    expect(writes).toBe(0);

    // The wizard's first step refused (a password that does not match): a 4xx, nothing changed.
    const refused = await app.fetch(
      new Request('http://localhost/setup/account', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: (get.headers.getSetCookie()[0] ?? '').split(';')[0] ?? '',
        },
        body: new URLSearchParams({ name: 'H', email: 'h@home.local', password: 'correct-horse-battery', confirm: 'nope' }).toString(),
      }),
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(writes).toBe(0);

    const accepted = await app.fetch(
      new Request('http://localhost/setup/account', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: (get.headers.getSetCookie()[0] ?? '').split(';')[0] ?? '',
        },
        body: new URLSearchParams({
          name: 'H',
          email: 'h@home.local',
          password: 'correct-horse-battery',
          confirm: 'correct-horse-battery',
        }).toString(),
      }),
    );
    expect(accepted.status).toBe(302);
    expect(writes).toBe(1);
  });
});

describe('wirePush', () => {
  it('turns a burst of writes into one tick, a moment later', async () => {
    const { db } = database();
    const server = createServer();
    servers.push(server);
    const wiring = wirePush(server, { db, build: () => undefined, tickMs: 60_000, nudgeMs: 30 });
    const tick = vi.spyOn(wiring.hub, 'tick');
    wiring.nudge();
    wiring.nudge();
    wiring.nudge();
    expect(tick).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(tick).toHaveBeenCalledTimes(1);
    // A later write is a later tick.
    wiring.nudge();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(tick).toHaveBeenCalledTimes(2);
    // Closed, a pending nudge never fires.
    wiring.nudge();
    wiring.close();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('upgrades only /d/push, and refuses anything else', async () => {
    const { db } = database();
    const server = createServer();
    servers.push(server);
    const wiring = wirePush(server, { db, build: () => undefined, tickMs: 60_000 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const outcome = (path: string): Promise<string> =>
      new Promise((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
        socket.on('unexpected-response', (_request, response) => resolve(`http ${response.statusCode}`));
        socket.on('error', () => resolve('refused'));
        socket.on('open', () => {
          socket.close();
          resolve('open');
        });
      });
    // No token: the hub's own 401, so the route reached it.
    expect(await outcome('/d/push')).toBe('http 401');
    // Anywhere else: the connection is dropped before any HTTP answer.
    expect(await outcome('/d/manifest')).toBe('refused');
    wiring.close();
  });
});
