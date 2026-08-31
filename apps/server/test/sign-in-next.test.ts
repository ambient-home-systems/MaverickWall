/**
 * Signing in finishes the journey, and cannot be told to finish somebody else's.
 *
 * Measured before this: `/admin/system` while signed out redirected to
 * `/admin/sign-in`, and signing in landed on `/admin`. The destination was
 * simply dropped — the gate did not send it and the handler always redirected
 * to the index.
 *
 * Carrying it back means the destination now arrives from the browser, which
 * makes it a boundary and makes an open redirect the thing to get right: rule
 * ten says to assume somebody exposes this box to the internet badly, and a
 * sign-in page that will forward to any URL a link names is a phishing
 * primitive with this household's own address bar behind it.
 *
 * So the enumeration of bypasses is unit-level, against `safeNextPath`, where
 * every case can be listed and read at once — and the round trip is driven
 * through the *real* app with a real cookie, because the two auth bugs this
 * project has already found were both in that seam rather than in either piece.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { safeNextPath, signInUrl, DEFAULT_AFTER_SIGN_IN } from '../src/auth/next-path.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Distinct per harness: Better Auth's rate-limit buckets are module-global. */
let nextAddress = 0;

function harness() {
  const address = `10.11.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-signin-next-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const now = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, timezone, theme, setup_completed_at, created_at, updated_at)
     VALUES ('singleton', 'Europe/London', 'board', ?, ?, ?)`,
  ).run(now, now, now);

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

  const call = async (path: string, init: RequestInit = {}): Promise<Response> =>
    await app.fetch(new Request(`http://localhost${path}`, init));

  const account = { email: `next-${nextAddress}@example.test`, password: 'correct-horse-battery' };
  const signUp = (): Promise<Response> =>
    call('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...account, name: 'Household' }),
    });

  /** The real sign-in form, posted the way a browser posts it. */
  const submitSignIn = (fields: Record<string, string>): Promise<Response> =>
    call('/admin/sign-in', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://localhost',
      },
      body: new URLSearchParams({
        email: account.email,
        password: account.password,
        ...fields,
      }).toString(),
    });

  return { call, signUp, submitSignIn };
}

/**
 * Every destination a link could name, and where it must land.
 *
 * Written as data rather than as an `it` each so the whole policy is one table
 * somebody can read down — and so adding a bypass to the list is one line
 * rather than a copied block.
 */
const REFUSED: ReadonlyArray<readonly [string, unknown]> = [
  ['an absolute http URL', 'http://evil.example/admin'],
  ['an absolute https URL', 'https://evil.example/admin'],
  ['a protocol-relative host', '//evil.example'],
  ['a protocol-relative host that then names the admin', '//evil.example/admin'],
  // A backslash is not a slash, but engines have normalised it to one before
  // deciding whether a value names a host.
  ['a backslash-relative host', '/\\evil.example'],
  ['a path outside the admin', '/setup'],
  ['the display', '/d/manifest'],
  // Already decoded once by URL parsing, which is exactly how these arrive.
  ['a percent-encoded absolute URL', 'http://evil.example/admin'],
  ['a percent-encoded protocol-relative host', '//evil.example'],
  ['a percent-encoded path outside the admin', '/setup'],
  // Still encoded: one decode short of the above, and refused for being a
  // string that does not begin with the admin at all.
  ['a doubly-encoded protocol-relative host', '%2f%2fevil.example'],
  ['a doubly-encoded absolute URL', 'http%3a%2f%2fevil.example'],
  ['a scheme with no slashes', 'javascript:alert(1)'],
  ['a bare host', 'evil.example'],
  ['the admin as a string prefix of another path', '/administrator-elsewhere'],
  ['a newline, which would split the header', '/admin\nLocation: http://evil.example'],
  ['a carriage return', '/admin\r\nSet-Cookie: a=b'],
  ['nothing at all', ''],
  ['a value a form did not send', undefined],
  ['a repeated field, which arrives as an array', ['/admin/system', 'http://evil.example']],
];

describe('safeNextPath', () => {
  it('keeps an ordinary admin destination', () => {
    expect(safeNextPath('/admin/system')).toBe('/admin/system');
    expect(safeNextPath('/admin')).toBe('/admin');
    expect(safeNextPath('/admin/walls/kitchen?tab=style')).toBe('/admin/walls/kitchen?tab=style');
  });

  for (const [what, value] of REFUSED) {
    it(`falls back to the admin index for ${what}`, () => {
      expect(safeNextPath(value)).toBe(DEFAULT_AFTER_SIGN_IN);
    });
  }

  it('refuses a destination too long to be a header somebody meant', () => {
    expect(safeNextPath(`/admin/${'a'.repeat(600)}`)).toBe(DEFAULT_AFTER_SIGN_IN);
  });
});

describe('signInUrl', () => {
  it('carries a real destination, encoded', () => {
    expect(signInUrl('/admin/walls/kitchen?tab=style')).toBe(
      '/admin/sign-in?next=%2Fadmin%2Fwalls%2Fkitchen%3Ftab%3Dstyle',
    );
  });

  it('leaves the parameter off when there is nothing to carry', () => {
    // The bare URL is what somebody bookmarks; `?next=/admin` is noise that
    // says the same thing.
    expect(signInUrl('/admin')).toBe('/admin/sign-in');
    expect(signInUrl('http://evil.example')).toBe('/admin/sign-in');
  });
});

describe('the sign-in round trip, through the real app', () => {
  it('carries the page somebody asked for all the way back to it', async () => {
    const { call, signUp, submitSignIn } = harness();
    await signUp();

    // Anonymous, reaching for a page. The gate has to say where they were
    // going, or nothing downstream can.
    const gated = await call('/admin/system');
    expect(gated.status).toBe(302);
    expect(gated.headers.get('location')).toBe('/admin/sign-in?next=%2Fadmin%2Fsystem');

    // The form for that URL has to carry it, because a POST sends its fields
    // and not its action's query string.
    const form = await (await call('/admin/sign-in?next=%2Fadmin%2Fsystem')).text();
    expect(form).toContain('name="next" value="/admin/system"');

    const signedIn = await submitSignIn({ next: '/admin/system' });
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get('location')).toBe('/admin/system');
    // And the session really was created — a redirect to the right place with
    // no cookie is the bug wearing the fix's Location header.
    expect(signedIn.headers.getSetCookie().join(';')).toContain('session');
  });

  it('keeps the query string, which is where half the admin destinations live', async () => {
    const { call, signUp } = harness();
    await signUp();

    const gated = await call('/admin/walls/kitchen?tab=style');
    expect(gated.headers.get('location')).toBe(
      '/admin/sign-in?next=%2Fadmin%2Fwalls%2Fkitchen%3Ftab%3Dstyle',
    );
  });

  it('sends a refused destination to the admin index and does not echo it back', async () => {
    const { call, signUp, submitSignIn } = harness();
    await signUp();

    /*
     * One of each shape rather than the whole table above: a successful
     * sign-in is rate limited per client and the whole list trips it, which
     * would fail this as a 429 and prove nothing. The enumeration is the unit
     * table's job; what has to be driven through the real handler is that the
     * value it redirects on is the validated one.
     */
    for (const value of ['http://evil.example/admin', '//evil.example', '/setup']) {
      const signedIn = await submitSignIn({ next: value });
      expect(signedIn.status).toBe(302);
      expect(signedIn.headers.get('location')).toBe('/admin');
    }

    // And the page rendered for a rejected value must not contain it, escaped
    // or otherwise — a form that hands a stranger's URL back is a redirector
    // one submission later.
    const page = await (
      await call('/admin/sign-in?next=' + encodeURIComponent('//evil.example'))
    ).text();
    expect(page).not.toContain('evil.example');
    expect(page).not.toContain('name="next"');
  });

  it('re-renders a failed sign-in still carrying the destination', async () => {
    // Getting the password wrong must not cost the journey. This is the branch
    // where a `next` that only lived in the URL would silently be lost.
    const { call, signUp } = harness();
    await signUp();

    const wrong = await call('/admin/sign-in', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://localhost',
      },
      body: new URLSearchParams({
        email: 'nobody@example.test',
        password: 'not-the-password',
        next: '/admin/system',
      }).toString(),
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain('name="next" value="/admin/system"');
  });

  it('does not send a POST somewhere it would arrive as a GET', async () => {
    // A refused POST's destination expects a body this redirect cannot carry,
    // so replaying it after sign-in would land on a page that reads as broken.
    const { call, signUp } = harness();
    await signUp();

    const gated = await call('/admin/system', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://localhost',
      },
      body: 'timezone=Europe%2FLondon',
    });
    expect(gated.status).toBe(302);
    expect(gated.headers.get('location')).toBe('/admin/sign-in');
  });

  it('still answers an API path with 401 rather than a redirect', async () => {
    // The gate's other branch, unchanged — and worth pinning, because the
    // rewrite here moved the line it used to share.
    const { call, signUp } = harness();
    await signUp();

    const api = await call('/api/screens');
    expect(api.status).toBe(401);
    expect(api.headers.get('location')).toBeNull();
  });
});
