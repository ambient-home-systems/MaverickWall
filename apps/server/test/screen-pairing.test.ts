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

async function harness(
  baseUrl = 'http://localhost',
  wallAddress?: { detected: string | undefined; portMapped: number | null | undefined; explicit: boolean },
) {
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
    ...(wallAddress !== undefined ? { wallAddress } : {}),
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

  it('records the viewport a wall reports on its poll, and ignores rubbish (RFC 005)', async () => {
    const h = await harness();
    const html = await (await h.post('http://192.168.1.10:8080/admin/screens', { name: 'Wall' })).text();
    const token = new URL(pairUrl(html) ?? '').searchParams.get('token');
    const id = () => (h.db.prepare(`SELECT id, report_w AS w, report_h AS h FROM screens LIMIT 1`).get() as { id: string; w: number | null; h: number | null });

    // A sane viewport is stored, so the editor can offer "match this screen".
    await h.call('http://192.168.1.10:8080/d/manifest?w=1080&h=1920', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(id()).toMatchObject({ w: 1080, h: 1920 });

    // A rubbish size does not overwrite the good one — bounds are on the server.
    await h.call('http://192.168.1.10:8080/d/manifest?w=0&h=999999', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(id()).toMatchObject({ w: 1080, h: 1920 });
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

/**
 * The eight-character code the pairing page shows, formatted `ABCD-EFGH`.
 *
 * Read out of the page's own markup rather than minted here, so the test pairs
 * with exactly what a household would read off the screen. The alphabet is the
 * unambiguous one from `tokens.ts`, which is what tells it apart from the URL in
 * the same page.
 */
function pairCode(html: string): string | undefined {
  const alphabet = '234679ACDEFGHJKMNPQRTUVWXYZ';
  const cls = `[${alphabet}]{4}-[${alphabet}]{4}`;
  return new RegExp(`<span class="code">(${cls})</span>`).exec(html)?.[1];
}

describe('when the supervisor knows the port state', () => {
  it('stops on a turned-off display port instead of handing out a dead link', async () => {
    // The exact fault that cost a real install a 404: the port is present but
    // disabled, so no link or code can work. The page says so and shows neither.
    const h = await harness('http://localhost:8080', {
      detected: undefined,
      portMapped: null,
      explicit: false,
    });
    const html = await (
      await h.post(
        'http://a0d7b954-maverick-wall:8080/admin/screens',
        { name: 'TV' },
        { [INGRESS_HEADER]: '/api/hassio_ingress/SESSION123' },
      )
    ).text();

    expect(html).toContain('display port is turned off');
    expect(html).toContain('Network');
    // No QR and no pairing URL, because they could only point at localhost.
    expect(html).not.toContain('<div class="qr">');
    expect(html).not.toContain('/pair?token=');
  });

  it('names the mapped port when the address is still localhost', async () => {
    // The port is on (mapped to 8090) but base_url was never set, so the link is
    // localhost. The fix should name 8090 rather than guess 8080.
    const h = await harness('http://localhost:8080', {
      detected: undefined,
      portMapped: 8090,
      explicit: false,
    });
    const html = await (
      await h.post(
        'http://a0d7b954-maverick-wall:8080/admin/screens',
        { name: 'TV' },
        { [INGRESS_HEADER]: '/api/hassio_ingress/SESSION123' },
      )
    ).text();

    expect(html).toContain('mapped to 8090');
    expect(html).toContain('nowhere from a wall screen');
  });
});

describe('pairing a screen by code', () => {
  async function screenWithCode(baseUrl?: string) {
    const h = baseUrl === undefined ? await harness() : await harness(baseUrl);
    const html = await (
      await h.post('http://192.168.1.10:8080/admin/screens', { name: 'TV' })
    ).text();
    const code = pairCode(html);
    expect(code, 'the pairing page should show a short code').toBeDefined();
    return { h, code: code as string };
  }

  it('shows a code a screen can type, alongside the QR', async () => {
    const { code } = await screenWithCode();
    // Eight characters from the unambiguous alphabet, split for reading.
    expect(code).toMatch(/^[234679ACDEFGHJKMNPQRTUVWXYZ]{4}-[234679ACDEFGHJKMNPQRTUVWXYZ]{4}$/);
  });

  it('pairs the screen, and the cookie it sets authorises the manifest', async () => {
    const { h, code } = await screenWithCode();

    const paired = await h.post('http://192.168.1.10:8080/pair', { code });
    expect(paired.status).toBe(200);
    expect(await paired.json()).toEqual({ ok: true });

    // The cookie is now in the jar. A wall polling with it gets its manifest —
    // the same proof the token path gets, one door over.
    const manifest = await h.call('http://192.168.1.10:8080/d/manifest');
    expect(manifest.status).toBe(200);
  });

  it('accepts the code with the household dash and lower case', async () => {
    const { h, code } = await screenWithCode();
    const typed = code.replace('-', '').toLowerCase();
    const paired = await h.post('http://192.168.1.10:8080/pair', { code: typed });
    expect(paired.status).toBe(200);
  });

  it('refuses a wrong code without saying which part was wrong', async () => {
    const { h } = await screenWithCode();
    const response = await h.post('http://192.168.1.10:8080/pair', { code: 'ZZZZ-ZZZZ' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { message?: string };
    expect(body.message).toBe('That code is not right, or it has expired.');

    // Nothing was paired: no cookie, so the manifest is still refused.
    const manifest = await h.call('http://192.168.1.10:8080/d/manifest');
    expect(manifest.status).toBe(401);
  });

  it('spends the code on the first pair, so a copy cannot reuse it', async () => {
    const { h, code } = await screenWithCode();
    expect((await h.post('http://192.168.1.10:8080/pair', { code })).status).toBe(200);
    // Same code again — it is gone now, and reads the same as a wrong one.
    expect((await h.post('http://192.168.1.10:8080/pair', { code })).status).toBe(400);
  });

  it('refuses a code whose window has closed', async () => {
    const { h, code } = await screenWithCode();
    // Backdate the expiry rather than wait a day: the guard is `readPairableScreens`,
    // and an expired row must drop out of it.
    h.db.prepare('UPDATE screens SET pairing_code_expires_at = ? WHERE name = ?').run(1, 'TV');
    expect((await h.post('http://192.168.1.10:8080/pair', { code })).status).toBe(400);
  });

  it('stops answering after a burst of wrong guesses', async () => {
    const { h } = await screenWithCode();
    // Twenty are allowed; the twenty-first from one address is turned away, so a
    // script cannot sit on the port and search the code space.
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await h.post('http://192.168.1.10:8080/pair', { code: 'ZZZZ-ZZZZ' });
      expect(response.status).toBe(400);
    }
    const blocked = await h.post('http://192.168.1.10:8080/pair', { code: 'ZZZZ-ZZZZ' });
    expect(blocked.status).toBe(429);
  });
});

/** The `/pair?token=…` we expect, given an origin, read back out of the page. */
function extractToken(html: string, origin: string): string {
  const token = new URL(pairUrl(html) ?? 'http://x/pair').searchParams.get('token') ?? '';
  return `${origin}/pair?token=${token}`;
}
