import { afterAll, describe, expect, it } from 'vitest';
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
import { INGRESS_HEADER } from '../src/http/ingress.js';

/**
 * Pairing a wall screen, driven through the real app.
 *
 * The thing under test is the address in the pairing link, because a wall
 * screen connects to the add-on's *port* with a display token and never
 * through Home Assistant ingress — so a link built from an ingress request's
 * own origin points at the supervisor's internal network and scans as nothing.
 * These prove the link carries an address a screen can actually reach, and
 * that the token it hands out works over the port it names.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextAddress = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function harness(baseUrl = 'http://localhost') {
  const address = `10.9.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-pair-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'p'.repeat(32), baseUrl },
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
  const post = (url: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    call(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields).toString(),
    });

  // Signed in exactly as the household is, through the wizard.
  await call(`http://localhost/setup?token=${setupToken.current().token}`);
  await post('http://localhost/setup/account', {
    name: 'Household', email: `family${nextAddress}@home.local`,
    password: 'correct-horse-battery', confirm: 'correct-horse-battery',
  });
  await post('http://localhost/setup/household', { timezone: 'Europe/London' });

  return { db, call, post };
}

/** The one link a screen is meant to open, pulled out of the pairing page. */
function pairUrl(html: string): string | undefined {
  return /(https?:\/\/[^<\s]*\/pair\?token=[^<\s"]+)/.exec(html)?.[1];
}

describe('adding a screen from the admin UI', () => {
  it('creates a screen and hands back a pairing link', async () => {
    const h = await harness();
    const response = await h.post('http://192.168.1.10:8080/admin/screens', { name: 'Kitchen' });
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain('Pair Kitchen');
    // A screen row now exists, unpaired but for its token.
    const count = (h.db.prepare('SELECT count(*) AS n FROM screens').get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it('names the address the request arrived on when that is the port', async () => {
    // On the port the request origin is exactly what a screen should use — it
    // is the address the household typed to get here.
    const h = await harness();
    const html = await (await h.post('http://192.168.1.10:8080/admin/screens', { name: 'Hall' })).text();
    expect(pairUrl(html)).toBe(extractToken(html, 'http://192.168.1.10:8080'));
    expect(html).not.toContain('nowhere from a wall screen');
  });

  it('the token it prints actually works over the port it names', async () => {
    // The whole point, proven end to end: the link is not decoration, the
    // token behind it authorises the manifest a wall polls.
    const h = await harness();
    const html = await (await h.post('http://192.168.1.10:8080/admin/screens', { name: 'Wall' })).text();
    const token = new URL(pairUrl(html) ?? '').searchParams.get('token');
    expect(token).not.toBeNull();

    const manifest = await h.call('http://192.168.1.10:8080/d/manifest', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(manifest.status).toBe(200);
  });
});

describe('pairing through Home Assistant ingress', () => {
  it('uses base_url, not the ingress origin a screen cannot reach', async () => {
    // The request arrives on the supervisor's internal host; the link must not.
    const h = await harness('http://192.168.1.50:8080');
    const html = await (
      await h.post(
        'http://a0d7b954-maverick-wall:8080/admin/screens',
        { name: 'Ingress' },
        { [INGRESS_HEADER]: '/api/hassio_ingress/SESSION123' },
      )
    ).text();

    expect(pairUrl(html)).toContain('http://192.168.1.50:8080/pair?token=');
    expect(pairUrl(html)).not.toContain('a0d7b954-maverick-wall');
    expect(html).not.toContain('nowhere from a wall screen');
  });

  it('says so plainly when base_url is still localhost', async () => {
    // Under ingress the request origin is useless and base_url is the only
    // source of the address — an unset one is a link to the tablet itself.
    const h = await harness('http://localhost:8080');
    const html = await (
      await h.post(
        'http://a0d7b954-maverick-wall:8080/admin/screens',
        { name: 'Unset' },
        { [INGRESS_HEADER]: '/api/hassio_ingress/SESSION123' },
      )
    ).text();

    expect(html).toContain('nowhere from a wall screen');
    expect(html).toContain('base_url');
  });
});

/** The `/pair?token=…` we expect, given an origin, read back out of the page. */
function extractToken(html: string, origin: string): string {
  const token = new URL(pairUrl(html) ?? 'http://x/pair').searchParams.get('token') ?? '';
  return `${origin}/pair?token=${token}`;
}
