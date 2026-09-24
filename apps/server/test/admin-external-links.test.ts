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
 * P1.1: the Store's "Source" link and the Advanced page's "Where to get it"
 * link are the only absolute outbound links the admin renders, and neither
 * carried a `target` — so inside the Home Assistant sidebar, where the admin
 * runs in an iframe, clicking either navigated *that frame* to GitHub, which
 * answers `X-Frame-Options: deny` and the browser shows "github.com refused
 * to connect". The URL itself is live; only the destination was wrong.
 *
 * This is the `admin-origins.test.ts` pattern turned the other way round:
 * that file crawls for a fetchable third-party reference and refuses it, and
 * this one crawls for a *navigable* one (an `<a href="http…">`) and requires
 * it to open a new tab (`target="_blank"`) without handing the new page a
 * `window.opener` back into this one (`rel` containing `noopener`).
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-extlinks-'));
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
    auth: { secret: 'p'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => '10.9.9.2',
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

  return { call, form, setupToken };
}

/** Every `<a …>` whose `href` is an absolute http(s) URL, with its attributes. */
function absoluteAnchors(html: string): { href: string; targetBlank: boolean; noopener: boolean }[] {
  const anchors = /<a\b([^>]*)\shref="(https?:\/\/[^"]*)"([^>]*)>/gi;
  const out: { href: string; targetBlank: boolean; noopener: boolean }[] = [];
  for (let m = anchors.exec(html); m !== null; m = anchors.exec(html)) {
    const attrs = `${m[1] ?? ''} ${m[3] ?? ''}`;
    out.push({
      href: m[2] as string,
      targetBlank: /\btarget="_blank"/.test(attrs),
      noopener: /\brel="[^"]*\bnoopener\b[^"]*"/.test(attrs),
    });
  }
  return out;
}

const PAGES = [
  '/admin',
  '/admin/calendars',
  '/admin/shifts',
  '/admin/shifts/types',
  '/admin/chores',
  '/admin/alerts',
  '/admin/home-assistant',
  '/admin/home-assistant/connection',
  '/admin/home-assistant/readings',
  '/admin/home-assistant/calendars',
  '/admin/home-assistant/lists',
  '/admin/home-assistant/alerts',
  // The four add pages behind them (P2.1).
  '/admin/home-assistant/readings/new',
  '/admin/home-assistant/calendars/new',
  '/admin/home-assistant/lists/new',
  '/admin/home-assistant/alerts/new',
  '/admin/modules',
  '/admin/modules/advanced',
  // The prefill card only draws when `?install=` resolves to a service entry
  // (the Countdown example, kind: service) — the second of the two links
  // this whole item is about.
  '/admin/modules/advanced?install=countdown-example',
  '/admin/modules/recipe',
  '/admin/walls',
  // The chooser, and the two add pages behind it (P2.2). `/admin/epaper` is a
  // redirect to the second now, so it is not a page to sweep.
  '/admin/walls/new',
  '/admin/walls/new/browser',
  '/admin/walls/new/epaper',
  '/admin/themes',
  '/admin/themes/new',
  '/admin/people',
  '/admin/system',
];

describe('every absolute outbound link opens a new tab', () => {
  it('carries target="_blank" and rel="noopener" wherever it appears', async () => {
    const h = await harness();

    await h.call(`/setup?token=${h.setupToken.current().token}`);
    await h.form('/setup/account', {
      name: 'Household', email: 'family@home.local',
      password: 'correct-horse-battery', confirm: 'correct-horse-battery',
    });
    await h.form('/setup/household', { timezone: 'Europe/London' });

    const found: { href: string; targetBlank: boolean; noopener: boolean }[] = [];
    for (const path of PAGES) {
      const response = await h.call(path);
      expect(response.status, path).toBe(200);
      const html = await response.text();
      for (const anchor of absoluteAnchors(html)) found.push({ ...anchor, href: `${path} -> ${anchor.href}` });
    }

    // An assertion over an empty crawl proves nothing — the Store's Source
    // link and the Advanced page's Where-to-get-it link must actually be
    // among what was found, or this test would pass on a build that deleted
    // both.
    expect(found.length, 'no absolute outbound link found at all').toBeGreaterThanOrEqual(2);

    for (const anchor of found) {
      expect(anchor.targetBlank, `${anchor.href} has no target="_blank"`).toBe(true);
      expect(anchor.noopener, `${anchor.href} has no rel="noopener"`).toBe(true);
    }
  });
});
