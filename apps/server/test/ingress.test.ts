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
import { baseHref, INGRESS_HEADER } from '../src/http/ingress.js';

/**
 * Running under Home Assistant ingress.
 *
 * The supervisor mounts the add-on under a per-session path, strips it before
 * forwarding, and tells us what it stripped. Everything this application emits
 * with a leading slash is wrong by exactly that prefix — and wrong in a way
 * that lands somewhere else inside Home Assistant rather than 404ing where
 * anybody would see it.
 *
 * Driven through the real app with the real header, because the two bugs this
 * found were both invisible to reasoning: a redirect that dropped the prefix,
 * and a cookie scoped to `/setup` that a browser at
 * `/api/hassio_ingress/<token>/setup` will never send back.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const PREFIX = '/api/hassio_ingress/SESSIONTOKEN123';
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-ingress-'));
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
    auth: { secret: 'a'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => '10.11.0.1',
    setupToken,
    dataDir,
  });

  /** A request as the supervisor forwards it: prefix stripped, header set. */
  const viaIngress = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set(INGRESS_HEADER, PREFIX);
    // The browser's origin is Home Assistant's, never ours.
    if (init.method !== undefined && init.method !== 'GET') {
      headers.set('origin', 'http://homeassistant.local:8123');
    }
    return app.fetch(new Request(`http://127.0.0.1:8080${path}`, { ...init, headers }));
  };

  const direct = async (path: string, init: RequestInit = {}): Promise<Response> =>
    app.fetch(new Request(`http://127.0.0.1:8080${path}`, init));

  return { db, app, setupToken, viaIngress, direct };
}

describe('the prefix itself', () => {
  it('builds a base href for both cases', () => {
    expect(baseHref('')).toBe('/');
    expect(baseHref(PREFIX)).toBe(`${PREFIX}/`);
  });
});

describe('redirects keep the prefix', () => {
  it('sends the root somewhere inside the add-on', async () => {
    /*
     * A wall display never comes through ingress — it has no Home Assistant
     * session. Somebody arriving here clicked the add-on in the sidebar, and
     * what they want is the settings; on a fresh install that is the wizard,
     * which is why this asserts the prefix rather than a fixed destination.
     */
    const h = harness();
    const response = await h.viaIngress('/');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')?.startsWith(`${PREFIX}/`)).toBe(true);
  });

  it('sends the root to the admin screens once setup is done', async () => {
    const h = harness();
    h.db.prepare(`UPDATE household_settings SET setup_completed_at = ?`).run(Date.now());
    h.db
      .prepare(
        `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
         VALUES ('u1', 'H', 'h@l.local', 1, ?, ?)`,
      )
      .run(Date.now(), Date.now());
    const response = await h.viaIngress('/');
    expect(response.headers.get('location')).toBe(`${PREFIX}/admin`);
  });

  it('keeps the prefix on the gate redirect', async () => {
    // Without this, `Location: /setup` sends the browser out of the add-on and
    // into Home Assistant's own UI, where it means nothing.
    const h = harness();
    const response = await h.viaIngress('/admin');
    expect(response.headers.get('location')).toBe(`${PREFIX}/setup`);
  });

  it('leaves a redirect alone when it is already prefixed', async () => {
    const h = harness();
    const response = await h.viaIngress('/admin');
    expect(response.headers.get('location')).not.toContain(`${PREFIX}${PREFIX}`);
  });

  it('changes nothing at all when the header is absent', async () => {
    // The overwhelmingly common case: a household browsing to the box.
    const h = harness();
    const response = await h.direct('/admin');
    expect(response.headers.get('location')).toBe('/setup');
  });
});

describe('the base element', () => {
  it('points at the add-on, and there is exactly one', async () => {
    const h = harness();
    const html = await (await h.viaIngress('/setup')).text();
    const tags = html.match(/<base href="[^"]*">/g) ?? [];
    expect(tags).toEqual([`<base href="${PREFIX}/">`]);
  });

  it('is the root when nothing is proxying', async () => {
    const h = harness();
    const html = await (await h.direct('/setup')).text();
    expect(html.match(/<base href="[^"]*">/g)).toEqual(['<base href="/">']);
  });

  it('leaves every link relative, so the base is what decides', async () => {
    /*
     * The reason this works with one tag rather than a prefix threaded through
     * forty call sites. An absolute href would ignore the base entirely and
     * escape the add-on silently.
     */
    const h = harness();
    // The base tag is the one absolute href on the page, and it is the whole
    // point — so it is removed before asking whether anything else is.
    const html = (await (await h.viaIngress('/setup')).text()).replace(/<base [^>]*>/, '');
    expect(html).not.toMatch(/href="\//);
    expect(html).not.toMatch(/action="\//);
  });
});

describe('the setup cookie', () => {
  it('is scoped to where the wizard actually is', async () => {
    /*
     * The bug that made the first-run screen impossible to finish. A cookie
     * with `Path=/setup` is never sent by a browser sitting at
     * `/api/hassio_ingress/<token>/setup`, so the wizard bounced back to
     * "enter the setup code" for ever: the code was right, the cookie was set,
     * and the very next request could not carry it.
     */
    const h = harness();
    const token = h.setupToken.current().token;
    const response = await h.viaIngress(`/setup?token=${token}`);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`Path=${PREFIX}/setup`);
  });

  it('stays scoped to the wizard when nothing is proxying', async () => {
    const h = harness();
    const token = h.setupToken.current().token;
    const response = await h.direct(`/setup?token=${token}`);
    expect(response.headers.get('set-cookie') ?? '').toContain('Path=/setup');
  });
});

describe('the cross-origin guard', () => {
  it('accepts a form post carrying Home Assistant\'s origin', async () => {
    /*
     * Under ingress the supervisor is the trust boundary: it will not forward
     * a request without a valid Home Assistant session, and nothing outside
     * the container network can reach the port it forwards from. Without this
     * every form in the add-on is refused.
     */
    const h = harness();
    // The wizard's own gate comes first: without the setup cookie it refuses
    // regardless of origin, so the cookie is collected the way a browser would.
    const token = h.setupToken.current().token;
    const opened = await h.viaIngress(`/setup?token=${token}`);
    const cookie = (opened.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const response = await h.viaIngress('/setup/account', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: 'name=Household&email=family@home.local&password=correct-horse-battery&confirm=correct-horse-battery',
    });
    // Created, and redirected onward — inside the add-on.
    expect(response.status).toBe(302);
    expect(response.headers.get('location')?.startsWith(`${PREFIX}/`)).toBe(true);
  });

  it('still refuses a foreign origin when nothing is proxying', async () => {
    const h = harness();
    const token = h.setupToken.current().token;
    const opened = await h.direct(`/setup?token=${token}`);
    const cookie = (opened.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const response = await h.direct('/setup/account', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://evil.example',
        cookie,
      },
      body: 'name=Household&email=family@home.local&password=correct-horse-battery&confirm=correct-horse-battery',
    });
    // The guard, not the wizard: JSON rather than a rendered page.
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('cross-origin');
  });
});

describe('a header nobody should trust', () => {
  it('ignores anything that is not a plain absolute path', async () => {
    /*
     * This header decides where a browser sends its next request and what goes
     * into a `<base>`. Only the supervisor can set it in a real deployment,
     * but "only in a real deployment" is not a reason to take it as given.
     */
    const h = harness();
    for (const bad of [
      'https://evil.example',
      '//evil.example',
      '/a/../../etc',
      'not-a-path',
      `/${'x'.repeat(300)}`,
      '/a"onload="alert(1)',
    ]) {
      const response = await h.app.fetch(
        new Request('http://127.0.0.1:8080/admin', { headers: { [INGRESS_HEADER]: bad } }),
      );
      // Treated as no prefix at all, which is the safe reading.
      expect(response.headers.get('location')).toBe('/setup');
    }
  });
});
