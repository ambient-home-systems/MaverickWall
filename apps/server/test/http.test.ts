import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { issueDisplayToken } from '../src/auth/tokens.js';
import { createApp } from '../src/http/app.js';

/**
 * The routes, exercised through Hono's fetch interface.
 *
 * Real routing, real status codes, real conditional requests — no network and
 * no browser. Anything that only works because a test reached inside the
 * handler would not be tested at all.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-http-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const now = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, timezone, theme, created_at, updated_at)
     VALUES ('singleton', 'America/New_York', 'board', ?, ?)`,
  ).run(now, now);

  const issued = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
     VALUES ('screen1', 'Kitchen', ?, ?, ?, ?)`,
  ).run(issued.tokenHash, now, now, now);

  const app = createApp({ db, appVersion: '0.1.0-test', bootNotices: [] });
  const call = (path: string, headers: Record<string, string> = {}) =>
    app.fetch(new Request(`http://localhost${path}`, { headers }));

  return { db, app, call, token: issued.token, dataDir };
}

describe('/healthz', () => {
  it('answers without a credential', async () => {
    // A monitoring check that needs a token is a monitoring check nobody sets
    // up. This is the endpoint a Docker healthcheck hits.
    const { call } = harness();
    const response = await call('/healthz');
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['version']).toBe('0.1.0-test');
    expect(typeof body['serverTime']).toBe('number');
  });

  it('reveals nothing about the household', async () => {
    // It is unauthenticated, so it must not name calendars, people or screens.
    const { call } = harness();
    const text = await (await call('/healthz')).text();
    expect(text).not.toContain('Kitchen');
    expect(text).not.toContain('America/New_York');
  });

  it('reports the schema as migrated', async () => {
    const { call } = harness();
    const body = (await (await call('/healthz')).json()) as Record<string, number>;
    expect(body['schemaVersion']).toBeGreaterThan(0);
  });
});

describe('/d/manifest', () => {
  it('refuses an unpaired screen', async () => {
    const { call } = harness();
    expect((await call('/d/manifest')).status).toBe(401);
    expect((await call('/d/manifest', { authorization: 'Bearer nonsense' })).status).toBe(401);
  });

  it('serves a manifest to a paired screen', async () => {
    const { call, token } = harness();
    const response = await call('/d/manifest', { authorization: `Bearer ${token}` });
    expect(response.status).toBe(200);

    const manifest = (await response.json()) as Record<string, unknown>;
    expect(manifest['manifestVersion']).toBe(1);
    expect(manifest['timezone']).toBe('America/New_York');
    expect(Array.isArray(manifest['days'])).toBe(true);
    expect((manifest['days'] as unknown[]).length).toBeGreaterThan(30);
  });

  it('accepts the pairing cookie as well as a bearer token', async () => {
    // A kiosk browser loading / cannot set headers.
    const { call, token } = harness();
    const response = await call('/d/manifest', { cookie: `mw_display=${token}` });
    expect(response.status).toBe(200);
  });

  it('answers 304 when nothing has changed', async () => {
    const { call, token } = harness();
    const first = await call('/d/manifest', { authorization: `Bearer ${token}` });
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();

    const second = await call('/d/manifest', {
      authorization: `Bearer ${token}`,
      'if-none-match': etag ?? '',
    });
    expect(second.status).toBe(304);
  });

  it('carries server time on a 304 as well as a 200', async () => {
    // Clock sync must not depend on the body being sent, or a display that is
    // correctly getting 304s would never correct its drift.
    const { call, token } = harness();
    const first = await call('/d/manifest', { authorization: `Bearer ${token}` });
    expect(first.headers.get('x-server-time')).toBeTruthy();

    const second = await call('/d/manifest', {
      authorization: `Bearer ${token}`,
      'if-none-match': first.headers.get('etag') ?? '',
    });
    expect(second.status).toBe(304);
    expect(second.headers.get('x-server-time')).toBeTruthy();
  });

  it('records when the screen was last seen', async () => {
    const { call, token, db } = harness();
    await call('/d/manifest', { authorization: `Bearer ${token}` });
    const screen = db.prepare("SELECT last_seen_at FROM screens WHERE id = 'screen1'").get() as {
      last_seen_at: number | null;
    };
    expect(screen.last_seen_at).toBeGreaterThan(0);
  });
});

describe('/pair', () => {
  it('exchanges a token for a cookie and redirects', async () => {
    // So the token appears once at pairing and never again in a URL, a log, or
    // a browser history entry someone later screenshots.
    const { call, token } = harness();
    const response = await call(`/pair?token=${token}`);
    expect(response.status).toBe(302);

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('mw_display=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('rejects a token that matches no screen', async () => {
    const { call } = harness();
    expect((await call('/pair?token=nope')).status).toBe(401);
  });

  it('explains a link with no token in it', async () => {
    const { call } = harness();
    expect((await call('/pair')).status).toBe(400);
  });
});

describe('everything else', () => {
  it('serves something rather than nothing at the root', async () => {
    // A blank screen is the one outcome to avoid, even before the display
    // bundle exists.
    const { call } = harness();
    const response = await call('/');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Maverick Wall');
  });

  it('404s an unknown path without leaking anything', async () => {
    const { call } = harness();
    const response = await call('/nope');
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, string>;
    expect(body['error']).toBe('not-found');
  });
});
