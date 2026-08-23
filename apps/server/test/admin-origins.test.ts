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

/**
 * Rule three, asserted on the wire: the server-rendered pages reference no
 * third-party origin. Not the display bundle (its own tests cover that) — the
 * admin and the wizard, which now carry a Material Design skin and two bundled
 * typefaces and must still work on a box with no internet at all.
 *
 * Every fetchable reference is checked — <link>, <script>, <img> and friends,
 * plus every url() and @import in the inline stylesheet — and each same-origin
 * asset the pages do reference is then requested through the app, so a typo'd
 * font path fails here rather than falling back to Arial for months
 * (font-display:swap makes that failure silent by design).
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-origins-'));
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
    auth: { secret: 'o'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => '10.9.9.1',
    setupToken,
    dataDir,
  });

  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = new Headers(init.headers);
    if (cookie !== '') headers.set('cookie', cookie);
    const response = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return response;
  };
  const form = (path: string, fields: Record<string, string>): Promise<Response> =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  return { call, form, setupToken, jar };
}

/**
 * Every reference the page would fetch while rendering. Anchors are excluded
 * on purpose — an <a href> navigates on a click, it does not load at render —
 * which is why "read the docs" links to this project's repository are fine.
 */
function fetchableReferences(html: string): string[] {
  const references: string[] = [];

  // src/href on elements the browser fetches. The markup is our own generator's
  // (attributes double-quoted), so this does not need a full parser.
  const attribute = /<(?:link|script|img|iframe|source|video|audio|embed|object)\b[^>]*?\s(?:src|href|data|poster)="([^"]*)"/gi;
  for (let m = attribute.exec(html); m !== null; m = attribute.exec(html)) {
    references.push(m[1] as string);
  }

  // url(...) and @import inside every inline <style>.
  const styles = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  for (let s = styles.exec(html); s !== null; s = styles.exec(html)) {
    const css = s[1] as string;
    const urls = /url\(\s*(?:'([^']*)'|"([^"]*)"|([^)'"\s]+))\s*\)/gi;
    for (let m = urls.exec(css); m !== null; m = urls.exec(css)) {
      references.push((m[1] ?? m[2] ?? m[3]) as string);
    }
    const imports = /@import\s+(?:'([^']*)'|"([^"]*)")/gi;
    for (let m = imports.exec(css); m !== null; m = imports.exec(css)) {
      references.push((m[1] ?? m[2]) as string);
    }
  }

  return references;
}

/** Off-origin: an absolute http(s) URL to anywhere, or a protocol-relative one. */
function isThirdParty(reference: string): boolean {
  if (reference.startsWith('data:')) return false;
  return /^(?:https?:)?\/\//i.test(reference);
}

const PAGES = [
  '/admin',
  '/admin/calendars',
  '/admin/shifts',
  '/admin/shifts/types',
  '/admin/chores',
  '/admin/alerts',
  '/admin/home-assistant',
  '/admin/modules',
  '/admin/modules/advanced',
  '/admin/modules/recipe',
  '/admin/displays',
  // The editor page (where /admin/display redirects): its display-editor.js
  // module script is a fetchable first-party asset this test must see answer.
  '/admin/displays/default',
  '/admin/epaper',
  '/admin/themes',
  '/admin/themes/new',
  '/admin/people',
  '/admin/system',
];

describe('the served pages and rule three', () => {
  it('reference no third-party origin, and every first-party asset resolves', async () => {
    const h = await harness();

    // The wizard first, unauthenticated — the page that must work before
    // anything else does.
    const pages = new Map<string, string>();
    // The token exchange redirects to the clean /setup URL with a cookie set.
    await h.call(`/setup?token=${h.setupToken.current().token}`);
    const wizard = await h.call('/setup');
    expect(wizard.status).toBe(200);
    pages.set('/setup', await wizard.text());

    await h.form('/setup/account', {
      name: 'Household', email: 'family@home.local',
      password: 'correct-horse-battery', confirm: 'correct-horse-battery',
    });
    await h.form('/setup/household', { timezone: 'Europe/London' });

    // The sign-in page, signed out — also served before any credential exists.
    const cookies = new Map(h.jar);
    h.jar.clear();
    const signIn = await h.call('/admin/sign-in');
    expect(signIn.status).toBe(200);
    pages.set('/admin/sign-in', await signIn.text());
    for (const [k, v] of cookies) h.jar.set(k, v);

    for (const path of PAGES) {
      const response = await h.call(path);
      expect(response.status, path).toBe(200);
      pages.set(path, await response.text());
    }

    const assets = new Set<string>();
    for (const [path, html] of pages) {
      for (const reference of fetchableReferences(html)) {
        expect(isThirdParty(reference), `${path} references ${reference}`).toBe(false);
        if (!reference.startsWith('data:')) assets.add(reference);
      }
    }

    // The pages must actually reference the bundled faces — an admin that
    // stopped using them would quietly turn this whole test into a no-op.
    expect([...assets].some((a) => a.endsWith('roboto.woff2'))).toBe(true);

    // And every same-origin asset must answer. Relative references resolve
    // against <base href="/">, so requesting them from the root is exactly
    // what a browser would do.
    for (const asset of assets) {
      const response = await h.call(asset.startsWith('/') ? asset : `/${asset}`);
      expect(response.status, `asset ${asset}`).toBe(200);
    }
  });
});
