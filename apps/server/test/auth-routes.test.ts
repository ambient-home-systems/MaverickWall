import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { randomBytes } from 'node:crypto';

/**
 * Auth wired into the real app, driven through Hono's fetch interface.
 *
 * `session.test.ts` proves the gates behave correctly against a stubbed
 * resolver. This proves the wiring: that Better Auth is actually mounted where
 * the gates expect it, that a cookie minted by the real sign-up route is one
 * the real gate accepts, and that the exemption for `/api/auth/*` does not
 * accidentally exempt anything else. Both of the auth bugs this project has
 * already found were in that seam rather than in either piece.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A distinct client address per harness.
 *
 * Better Auth keeps its rate-limit counters in module-global memory, so they
 * outlive an auth instance and even a database — a fresh instance was already
 * rate limited by what a previous one had done. Giving each harness its own
 * address is what keeps these tests independent, and it only works because
 * the buckets really are per-client.
 */
let nextAddress = 0;

function harness(options: { setupComplete?: boolean } = {}) {
  const address = `10.9.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-authroute-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const now = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, timezone, theme, setup_completed_at, created_at, updated_at)
     VALUES ('singleton', 'America/New_York', 'board', ?, ?, ?)`,
  ).run(options.setupComplete === false ? null : now, now, now);

  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'k'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => address,
    dataDir,
  });

  const call = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`http://localhost${path}`, init));

  const signUp = (email: string) =>
    call('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'correct-horse-battery', name: 'Household' }),
    });

  return { db, call, signUp };
}

function cookieFrom(response: Response): string {
  const jar = response.headers.getSetCookie?.() ?? [];
  const raw = jar.length > 0 ? jar : [response.headers.get('set-cookie') ?? ''];
  return raw
    .filter(Boolean)
    .map((c) => c.split(';')[0])
    .join('; ');
}

describe('auth mounted in the app', () => {
  it('lets the first account sign up without being signed in', async () => {
    // The deadlock this project already hit once: creating an account requires
    // the sign-up endpoint, and the endpoint sat behind the gate that only an
    // account could open.
    const { signUp } = harness();
    const response = await signUp('first@example.com');
    expect(response.status).toBeLessThan(300);
  });

  it('refuses a second sign-up even with a valid session', async () => {
    // There is no public registration. Rule ten: assume the port is reachable.
    const { signUp } = harness();
    await signUp('first@example.com');

    const second = await signUp('intruder@example.com');
    expect(second.status).toBe(403);
    const body = (await second.json()) as Record<string, string>;
    expect(body['error']).toBe('signup-closed');
  });

  it('accepts the cookie the real sign-up route minted', async () => {
    // The seam. A cookie from the real library, presented to the real gate.
    const { signUp, call } = harness();
    const cookie = cookieFrom(await signUp('kitchen@example.com'));
    expect(cookie).toBeTruthy();

    const response = await call('/admin', { headers: { cookie } });
    expect(response.status).not.toBe(302);
    expect(response.status).not.toBe(401);
  });

  it('redirects an anonymous page load to sign-in and 401s an API call', async () => {
    const { call } = harness();

    const page = await call('/admin');
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/admin/sign-in');

    const api = await call('/api/sources');
    expect(api.status).toBe(401);
  });

  it('protects /admin itself, not only what is under it', async () => {
    // `/admin/*` does not match `/admin`. Registering only the wildcard leaves
    // the index open while the route table looks correct.
    const { call } = harness();
    expect((await call('/admin')).status).toBe(302);
    expect((await call('/admin/calendars')).status).toBe(302);
  });

  it('leaves the display and health paths open', async () => {
    // Rule nine. A half-configured household is exactly when the screen most
    // needs to say something, and a health check nobody can reach is useless.
    const { call } = harness();
    expect((await call('/healthz')).status).toBe(200);
    expect((await call('/d/manifest')).status).toBe(401);
    expect((await call('/')).status).toBe(200);
  });

  it('does not exempt paths that merely start like the auth prefix', async () => {
    // `/api/authorised` is not `/api/auth/`. A prefix check on the wrong
    // boundary would quietly open it.
    const { call } = harness();
    expect((await call('/api/authorised-thing')).status).toBe(401);
  });

  it('rate limits one client without touching another', async () => {
    // The failure this guards against is a household locked out of its own
    // wall because a screen polled too eagerly. Before the client address was
    // carried through, every caller shared a single bucket and a fresh
    // instance with an empty database was already rate limited.
    const noisy = harness();
    const quiet = harness();

    let limited = false;
    for (let attempt = 0; attempt < 12 && !limited; attempt++) {
      const response = await noisy.call('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password-here' }),
      });
      limited = response.status === 429;
    }
    expect(limited).toBe(true);

    // The other household member is unaffected.
    const response = await quiet.signUp('unaffected@example.com');
    expect(response.status).not.toBe(429);
  });

  it('ignores a client-supplied address header', async () => {
    // Otherwise anyone on the LAN picks their own bucket and the limit is
    // decorative. The server overwrites the header from the socket.
    const { call, signUp } = harness();
    await signUp('real@example.com');

    let limited = false;
    for (let attempt = 0; attempt < 12 && !limited; attempt++) {
      const response = await call('/api/auth/sign-in/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // A different forged address on every attempt. If this were trusted,
          // each would get a fresh bucket and the limit would never trip.
          'x-mw-client-ip': `203.0.113.${attempt}`,
        },
        body: JSON.stringify({ email: 'real@example.com', password: 'wrong-password-here' }),
      });
      limited = response.status === 429;
    }
    expect(limited).toBe(true);
  });

  it('drops a forged address header when the socket address is unknown', async () => {
    // The fallback path. If the address cannot be resolved the limit degrades
    // to one shared bucket, which is poor — but it must not degrade to a
    // client naming its own bucket, which is no limit at all.
    const dataDir = mkdtempSync(join(tmpdir(), 'mw-authroute-'));
    roots.push(dataDir);
    const { db } = openDatabase({ dataDir });
    runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
    const stamp = Date.now();
    db.prepare(
      `INSERT INTO household_settings (id, timezone, theme, setup_completed_at, created_at, updated_at)
       VALUES ('singleton', 'America/New_York', 'board', ?, ?, ?)`,
    ).run(stamp, stamp, stamp);

    const app = createApp({
      db,
      appVersion: '0.1.0-test',
      bootNotices: [],
      auth: { secret: 'k'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
      clientAddress: () => undefined,
      dataDir,
    });

    let limited = false;
    for (let attempt = 0; attempt < 12 && !limited; attempt++) {
      const response = await app.fetch(
        new Request('http://localhost/api/auth/sign-in/email', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mw-client-ip': `198.51.100.${attempt}`,
          },
          body: JSON.stringify({ email: 'ghost@example.com', password: 'wrong-password-here' }),
        }),
      );
      limited = response.status === 429;
    }
    expect(limited).toBe(true);
  });

  it('signs out and stops accepting the cookie', async () => {
    const { signUp, call } = harness();
    const cookie = cookieFrom(await signUp('bye@example.com'));

    const before = await call('/admin', { headers: { cookie } });
    expect(before.status).not.toBe(302);

    await call('/api/auth/sign-out', { method: 'POST', headers: { cookie } });

    const after = await call('/admin', { headers: { cookie } });
    expect(after.status).toBe(302);
  });
});
