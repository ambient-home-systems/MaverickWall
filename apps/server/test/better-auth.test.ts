import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createAuth, createSessionResolver, resolveBaseUrl } from '../src/auth/better-auth.js';

/**
 * The one integration test against the real, installed better-auth package.
 *
 * better-auth.ts was written against a hand-written type shim because the
 * library could not be installed in the environment that wrote it. Typechecking
 * against the real library's types proves the shapes line up; it proves nothing
 * about whether a real sign-up produces a cookie that a real getSession call
 * accepts. That is what this exercises, against a real temp SQLite database
 * migrated with the project's own migrations.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, '..', 'migrations');
const BASE_URL = 'http://localhost:4000';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function migratedAuth() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-auth-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  const outcome = runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  if (outcome.status !== 'current') {
    throw new Error(`migration did not complete: ${JSON.stringify(outcome)}`);
  }
  const auth = createAuth({ db, secret: 'x'.repeat(32), baseUrl: BASE_URL });
  return auth;
}

function extractCookie(response: Response): string {
  const raw = response.headers.getSetCookie?.() ?? [];
  const single = raw.length > 0 ? raw : response.headers.has('set-cookie') ? [response.headers.get('set-cookie')!] : [];
  if (single.length === 0) throw new Error('sign-up response set no cookie');
  return single.map((c) => c.split(';')[0]).join('; ');
}

describe('createAuth against the real better-auth library', () => {
  it('signs a user up through the real handler and mints a session cookie', async () => {
    const auth = migratedAuth();

    const response = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'family@example.com', password: 'correct-horse-battery', name: 'Family' }),
      }),
    );

    expect(response.status).toBeLessThan(300);
    const body = (await response.json()) as { user?: { email?: string } };
    expect(body.user?.email).toBe('family@example.com');
  });

  it('resolves a signed-in session back to a SessionUser via createSessionResolver', async () => {
    const auth = migratedAuth();

    const signUp = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'kitchen@example.com', password: 'correct-horse-battery', name: 'Kitchen' }),
      }),
    );
    const cookie = extractCookie(signUp);

    const resolver = createSessionResolver(auth);
    const user = await resolver.resolve(
      new Request(`${BASE_URL}/admin`, { headers: { cookie } }),
    );

    expect(user).toBeDefined();
    expect(user?.email).toBe('kitchen@example.com');
    expect(user?.name).toBe('Kitchen');
    expect(typeof user?.id).toBe('string');
  });

  it('resolves to undefined with no cookie, and never throws', async () => {
    const auth = migratedAuth();
    const resolver = createSessionResolver(auth);

    const user = await resolver.resolve(new Request(`${BASE_URL}/admin`));
    expect(user).toBeUndefined();

    const garbage = await resolver.resolve(
      new Request(`${BASE_URL}/admin`, { headers: { cookie: 'better-auth.session_token=not-a-real-token' } }),
    );
    expect(garbage).toBeUndefined();
  });

  it('rejects a second sign-up the same way real callers will see it', async () => {
    const auth = migratedAuth();
    const attempt = () =>
      auth.handler(
        new Request(`${BASE_URL}/api/auth/sign-up/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'dup@example.com', password: 'correct-horse-battery', name: 'Dup' }),
        }),
      );

    const first = await attempt();
    expect(first.status).toBeLessThan(300);

    const second = await attempt();
    expect(second.status).toBeGreaterThanOrEqual(400);
  });
});

describe('resolveBaseUrl', () => {
  it('falls back to the configured base URL when proxy headers are untrusted', () => {
    const headers = new Headers({ 'x-forwarded-host': 'attacker.example', 'x-ingress-path': '/evil' });
    expect(resolveBaseUrl(headers, BASE_URL, false)).toEqual({ baseUrl: BASE_URL });
  });

  it('falls back when trusted but no forwarded host is present', () => {
    const headers = new Headers();
    expect(resolveBaseUrl(headers, BASE_URL, true)).toEqual({ baseUrl: BASE_URL });
  });

  it('derives the ingress origin and basePath when trusted and present', () => {
    const headers = new Headers({
      'x-forwarded-host': 'homeassistant.local:8123',
      'x-forwarded-proto': 'https',
      'x-ingress-path': '/api/hassio_ingress/abc123',
    });
    expect(resolveBaseUrl(headers, BASE_URL, true)).toEqual({
      baseUrl: 'https://homeassistant.local:8123',
      basePath: '/api/hassio_ingress/abc123/api/auth',
    });
  });

  it('defaults to http and omits basePath when there is no ingress path', () => {
    const headers = new Headers({ 'x-forwarded-host': 'homeassistant.local:8123' });
    expect(resolveBaseUrl(headers, BASE_URL, true)).toEqual({ baseUrl: 'http://homeassistant.local:8123' });
  });
});
