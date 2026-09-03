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
 * `screens.lan_only` (RFC — Option C), driven through the real app.
 *
 * The eInk frame carries its token in a URL rather than an `HttpOnly` cookie,
 * because a dumb panel cannot hold one — and a URL is the one credential in
 * this product a household is expected to hand-copy into a device's own
 * config, which makes it more likely than a wall's cookie to end up somewhere
 * with weaker access control than this app. This does not make a leaked
 * token easier to guess; it bounds what it is worth once it has leaked.
 *
 * The connecting address is read off a test-only header rather than a single
 * address baked into the harness, so one paired screen can be hit from a
 * public, a private and a loopback address within the same test — the thing
 * actually under test is which of those `lan_only` lets through.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const TEST_ADDRESS_HEADER = 'x-test-address';
/** A header value meaning "simulate an address that could not be determined". */
const UNDETERMINED = '__undetermined__';
let nextHarness = 0;

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-lanonly-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(
    stamp,
    stamp,
  );

  // Setup traffic (account creation, household settings) never sets the
  // test-address header, so it needs its own per-harness fallback rather
  // than sharing one `undefined` bucket across every test in this file —
  // that collapsed every harness's sign-up onto one rate-limit bucket, the
  // exact "the wizard's own sign-up shared the no-IP bucket" bug this
  // project has already found once.
  const defaultAddress = `10.30.0.${++nextHarness}`;

  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'l'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    // A test-only escape hatch: the real getter is `getConnInfo`, which
    // needs a live socket this harness does not have. Reading a header
    // instead is exactly what the LAN-only check must *not* do in
    // production — see `clientAddress` in app.ts, which never reads one.
    clientAddress: (c) => {
      const header = c.req.header(TEST_ADDRESS_HEADER);
      if (header === UNDETERMINED) return undefined;
      return header ?? defaultAddress;
    },
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
  const from = (url: string, address: string | undefined): Promise<Response> =>
    call(url, address === undefined ? {} : { headers: { [TEST_ADDRESS_HEADER]: address } });
  const post = (url: string, fields: Record<string, string>) =>
    call(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  await call(`http://localhost/setup?token=${setupToken.current().token}`);
  await post('http://localhost/setup/account', {
    name: 'Household',
    email: `lanonly${Math.random()}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await post('http://localhost/setup/household', { timezone: 'Europe/London' });

  const configHtml = await (
    await post('http://localhost:8080/admin/epaper', { name: 'Hallway', preset: 'seeed-7in5', rotation: '0' })
  ).text();
  const url = /(https?:\/\/[^"<\s]*\/d\/epaper\/[^"<\s]+)/.exec(configHtml)?.[1];
  if (url === undefined) throw new Error('no frame URL on the config page');
  const screenId = (db.prepare('SELECT id FROM screens LIMIT 1').get() as { id: string }).id;

  return { db, call, post, from, url, screenId };
}

function lanOnlyOf(db: SqliteDatabase, id: string): number {
  const row = readAdminScreens(db).find((s) => s.id === id);
  if (row === undefined) throw new Error(`no admin row for screen ${id}`);
  return row.lanOnly;
}

const B = 'http://localhost:8080';

describe('screens.lan_only', () => {
  it('is off by default, so any address gets the frame', async () => {
    const h = await harness();
    expect(lanOnlyOf(h.db, h.screenId)).toBe(0);

    const res = await h.from(h.url, '203.0.113.9'); // TEST-NET-3, a public-space example address
    expect(res.status).toBe(200);
  });

  it('refuses a public address once set, and still answers a private one', async () => {
    const h = await harness();
    h.db.prepare(`UPDATE screens SET lan_only = 1 WHERE id = ?`).run(h.screenId);

    const fromThePublicInternet = await h.from(h.url, '203.0.113.9');
    expect(fromThePublicInternet.status).toBe(403);

    const fromTheKitchenLan = await h.from(h.url, '192.168.1.42');
    expect(fromTheKitchenLan.status).toBe(200);
  });

  it('still answers loopback and CGNAT addresses, which are not "the internet" either', async () => {
    const h = await harness();
    h.db.prepare(`UPDATE screens SET lan_only = 1 WHERE id = ?`).run(h.screenId);

    expect((await h.from(h.url, '127.0.0.1')).status).toBe(200);
    expect((await h.from(h.url, '100.64.0.5')).status).toBe(200); // CGNAT, e.g. Tailscale
  });

  it('fails closed when the connecting address cannot be determined', async () => {
    const h = await harness();
    h.db.prepare(`UPDATE screens SET lan_only = 1 WHERE id = ?`).run(h.screenId);

    const res = await h.from(h.url, UNDETERMINED);
    expect(res.status).toBe(403);
  });

  it('never refuses a wrong token differently: still a 404, address aside', async () => {
    const h = await harness();
    h.db.prepare(`UPDATE screens SET lan_only = 1 WHERE id = ?`).run(h.screenId);

    const res = await h.from(`${B}/d/epaper/not-a-real-token.png`, '203.0.113.9');
    expect(res.status).toBe(404);
  });

  it('is toggled from the admin page, and an unticked box turns it back off', async () => {
    const h = await harness();
    const viewUrl = `${B}/admin/epaper/${h.screenId}`;

    await h.post(`${viewUrl}/lan-only`, { lan_only: '1' });
    expect(lanOnlyOf(h.db, h.screenId)).toBe(1);
    const html = await (await h.call(viewUrl)).text();
    expect(/name="lan_only"[^>]*checked/.test(html)).toBe(true);

    // A browser sends nothing at all for an unticked checkbox.
    await h.post(`${viewUrl}/lan-only`, {});
    expect(lanOnlyOf(h.db, h.screenId)).toBe(0);
  });
});
