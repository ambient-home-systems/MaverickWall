import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { readAdminScreens } from '../src/api/queries.js';

/**
 * `screens.last_seen_ip`, driven through the real app.
 *
 * The column has existed since the table did, and both `/d/manifest` and
 * `/d/epaper/:file` always called `touchScreen` with a literal `null` for the
 * address — so the admin had a detective control it never populated. These
 * pin the fix: a real connecting address, taken the same way `isTrustedIngress`
 * already takes one (`clientAddress`), ends up on the screen's admin row.
 *
 * One fixed address per harness, rather than the incrementing address other
 * suites in this file's family use, because the point here is that a
 * *specific* address round-trips into the database — an incrementing one
 * would make the assertion depend on how many requests setup happens to send.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextHarness = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function harness() {
  const address = `10.42.0.${++nextHarness}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-lastseen-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(
    stamp,
    stamp,
  );

  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'q'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => address,
    setupToken,
    dataDir,
  });

  const jar = new Map<string, string>();
  const call = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = new Headers(init.headers);
    if (cookie !== '') headers.set('cookie', cookie);
    const response = await app.fetch(new Request(url, { ...init, headers }));
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return response;
  };
  const post = (url: string, fields: Record<string, string>) =>
    call(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  await call(`http://localhost/setup?token=${setupToken.current().token}`);
  await post('http://localhost/setup/account', {
    name: 'Household',
    email: `lastseen${nextHarness}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await post('http://localhost/setup/household', { timezone: 'Europe/London' });

  return { db, call, post, address };
}

const B = 'http://localhost:8080';
const frameUrl = (html: string): string | undefined =>
  /(https?:\/\/[^"<\s]*\/d\/epaper\/[^"<\s]+)/.exec(html)?.[1];

function adminScreen(db: SqliteDatabase, id: string) {
  const row = readAdminScreens(db).find((s) => s.id === id);
  if (row === undefined) throw new Error(`no admin row for screen ${id}`);
  return row;
}

describe('screens.last_seen_ip', () => {
  it('is null until a screen has ever been seen', async () => {
    const h = await harness();
    const html = await (await h.post(`${B}/admin/screens`, { name: 'Wall' })).text();
    const token = /\/pair\?token=([^<\s"]+)/.exec(html)?.[1];
    if (token === undefined) throw new Error('no pairing token in the admin page');
    const screenId = (h.db.prepare('SELECT id FROM screens LIMIT 1').get() as { id: string }).id;

    expect(adminScreen(h.db, screenId).lastSeenIp).toBeNull();
  });

  it("records the connecting address for a browser wall's manifest poll", async () => {
    const h = await harness();
    const html = await (await h.post(`${B}/admin/screens`, { name: 'Wall' })).text();
    const token = /\/pair\?token=([^<\s"]+)/.exec(html)?.[1];
    if (token === undefined) throw new Error('no pairing token in the admin page');
    const screenId = (h.db.prepare('SELECT id FROM screens LIMIT 1').get() as { id: string }).id;

    const res = await h.call(`${B}/d/manifest`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);

    expect(adminScreen(h.db, screenId).lastSeenIp).toBe(h.address);
  });

  it("records the connecting address for an eInk panel's frame fetch", async () => {
    const h = await harness();
    const configHtml = await (
      await h.post(`${B}/admin/epaper`, { name: 'Hallway', preset: 'seeed-7in5', rotation: '0' })
    ).text();
    const url = frameUrl(configHtml);
    if (url === undefined) throw new Error('no frame URL on the config page');
    const screenId = (h.db.prepare('SELECT id FROM screens LIMIT 1').get() as { id: string }).id;

    // Not yet seen: minting the URL is not the same as a device fetching it.
    expect(adminScreen(h.db, screenId).lastSeenIp).toBeNull();

    const res = await h.call(url);
    expect(res.status).toBe(200);

    expect(adminScreen(h.db, screenId).lastSeenIp).toBe(h.address);
  });
});
