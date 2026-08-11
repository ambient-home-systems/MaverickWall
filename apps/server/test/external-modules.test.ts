import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { pollExternalModules } from '../src/modules/external/index.js';
import { issueDisplayToken } from '../src/auth/tokens.js';

/**
 * The third-party module path, end to end (docs/rfc-001-module-framework.md).
 *
 * A real HTTP module on loopback, added through the real admin route, polled by
 * the real job, and read back from the manifest a real screen polls. The tests
 * that matter are: a valid panel reaches the wall, and a body that is not Panel
 * Data is refused and never drawn.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
const servers: Server[] = [];
let n = 0;
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  for (const server of servers) server.close();
});

async function fakeModule(): Promise<{ base: string; body: () => unknown; setBody: (b: unknown) => void }> {
  let current: unknown = { kind: 'stat', title: 'Bins', value: '2', caption: 'days' };
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    response.setHeader('content-type', 'application/json');
    if (url === '/maverick.json') {
      response.end(JSON.stringify({ name: 'Bin day', version: '1.0.0', contract: 1 }));
      return;
    }
    if (url === '/panel') {
      response.end(JSON.stringify(current));
      return;
    }
    response.writeHead(404);
    response.end('{}');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    body: () => current,
    setBody: (b) => {
      current = b;
    },
  };
}

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-ext-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const fetcher = createFetcher();
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'e'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher,
    clientAddress: () => `10.9.0.${++n}`,
    setupToken,
    dataDir,
  });

  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie !== '') headers.set('cookie', cookie);
    const res = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return res;
  };
  const form = (path: string, fields: Record<string, string>) =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  await call(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', {
    name: 'H', email: `e${n}@home.local`,
    password: 'correct-horse-battery', confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });

  const manifest = async (): Promise<{ panels: Record<string, unknown>; display: { blocks: string[] } }> => {
    const issued = issueDisplayToken();
    const at = Date.now();
    db.prepare(
      `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
       VALUES ('s1','Wall',?,?,?,?) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash`,
    ).run(issued.tokenHash, at, at, at);
    const res = await call('/d/manifest', { headers: { authorization: `Bearer ${issued.token}` } });
    return (await res.json()) as { panels: Record<string, unknown>; display: { blocks: string[] } };
  };

  return { db, call, form, manifest, poll: () => pollExternalModules(db, fetcher) };
}

function moduleId(db: ReturnType<typeof openDatabase>['db']): string {
  return (db.prepare(`SELECT id FROM external_modules LIMIT 1`).get() as { id: string }).id;
}

describe('third-party modules', () => {
  it('adds a module, polls it, and draws its panel on the wall', async () => {
    const h = await harness();
    const mod = await fakeModule();

    const added = await h.form('/admin/modules', { url: mod.base });
    expect(added.status).toBe(302);

    const id = moduleId(h.db);
    const key = `ext:${id}`;

    // Its block is on the wall, and the module took its own name from /maverick.json.
    const before = await h.manifest();
    expect(before.display.blocks).toContain(key);
    const listed = await (await h.call('/admin/modules')).text();
    expect(listed).toContain('Bin day');

    // After a poll the manifest carries the validated panel under its key.
    await h.poll();
    const after = await h.manifest();
    expect(after.panels[key]).toEqual({ kind: 'stat', title: 'Bins', value: '2', caption: 'days' });
  });

  it('refuses a body that is not Panel Data, and records the error', async () => {
    const h = await harness();
    const mod = await fakeModule();
    mod.setBody({ kind: 'website', url: 'https://evil' });
    await h.form('/admin/modules', { url: mod.base });
    const id = moduleId(h.db);

    await h.poll();
    const row = h.db.prepare(`SELECT panel, last_error FROM external_modules WHERE id = ?`).get(id) as {
      panel: string | null;
      last_error: string | null;
    };
    expect(row.panel).toBeNull();
    expect(row.last_error).not.toBeNull();
    // Nothing drawn: no panel under the key.
    expect((await h.manifest()).panels[`ext:${id}`]).toBeUndefined();
  });

  it('turning a module off takes its block off the wall; removing it deletes it', async () => {
    const h = await harness();
    const mod = await fakeModule();
    await h.form('/admin/modules', { url: mod.base });
    const id = moduleId(h.db);
    const key = `ext:${id}`;

    await h.form(`/admin/modules/${id}/toggle`, {});
    expect((await h.manifest()).display.blocks).not.toContain(key);

    await h.form(`/admin/modules/${id}/remove`, {});
    expect(h.db.prepare(`SELECT count(*) c FROM external_modules`).get()).toEqual({ c: 0 });
  });
});
