/**
 * The confirmation strip's plumbing (RFC 009 Phase 3.1).
 *
 * The browser drives the strip end to end in `browser-admin.test.ts`; these are
 * the three things about it that are cheap to check here and expensive to
 * notice anywhere else:
 *
 *  - the redirect actually carries the token, through the *real* app rather
 *    than by reading the helper back to itself;
 *  - dismissing keeps the rest of the query, because a page prefilled by
 *    `?install=…` or `?template=…` losing its prefill on dismiss would be a
 *    smaller version of the bug this whole phase is about; and
 *  - every href it emits is relative. That is the one property Home Assistant
 *    ingress depends on and the one no visual check can see: an absolute `/…`
 *    resolves outside the add-on, into Home Assistant's own UI, and a
 *    household on the sidebar would press Dismiss and leave the application.
 */
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
import { SAVED_MESSAGES } from '../src/http/saved.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextAddress = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function harness() {
  const address = `10.31.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-saved-'));
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
    auth: { secret: 's'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => address,
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

  await call(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', {
    name: 'Household', email: 'family@home.local',
    password: 'correct-horse-battery', confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });

  return { db, call, form };
}

/** The strip's markup, if the page carries one. */
function stripOf(html: string): string | undefined {
  return /<div class="saved" [^>]*>[\s\S]*?<\/div>/.exec(html)?.[0];
}

describe('the confirmation strip', () => {
  it('is what a save redirects to, and it names the thing that was saved', async () => {
    const h = await harness();
    const saved = await h.form('/admin/system/timezone', { timezone: 'Europe/Paris' });
    expect(saved.status).toBe(302);
    expect(saved.headers.get('location')).toBe('/admin/system?saved=timezone');

    const page = await (await h.call('/admin/system?saved=timezone')).text();
    expect(page).toContain('Timezone saved.');
    expect(stripOf(page)).toContain('aria-live="polite"');
  });

  it('says nothing on the page a save did not land on', async () => {
    const h = await harness();
    expect(stripOf(await (await h.call('/admin/system')).text())).toBeUndefined();
    // And nothing for a token the application never mints — the value is only
    // ever a key into a table of literals, so there is nothing to inject and
    // nothing to echo, but a page that invented a confirmation for a stranger's
    // URL would be the dishonest half of the problem this solves.
    const crafted = await (await h.call('/admin/system?saved=%3Cscript%3Ealert(1)%3C%2Fscript%3E')).text();
    expect(stripOf(crafted)).toBeUndefined();
    expect(crafted, 'the token is a key, never text — nothing of it reaches the page').not.toContain('alert(1)');
  });

  it('keeps the rest of the query when it is dismissed', async () => {
    const h = await harness();
    // A page that is prefilled by a query parameter must still be prefilled
    // after the strip is dismissed.
    const page = await (await h.call('/admin/calendars?saved=calendar-added&sort=name')).text();
    const strip = stripOf(page) ?? '';
    expect(strip).toContain('Calendar added.');
    expect(strip).toContain('href="admin/calendars?sort=name"');
  });

  it('emits only relative hrefs, so ingress carries them', async () => {
    const h = await harness();
    const page = await (await h.call('/admin/calendars?saved=calendar-added')).text();
    const strip = stripOf(page) ?? '';
    expect(strip).toContain('href="admin/calendars"');
    // The one thing that would break the add-on: a leading slash resolves past
    // the ingress prefix and out of the application entirely.
    expect(strip).not.toMatch(/href="\//);
  });

  it('has a sentence for every token, and every sentence reads as one', () => {
    // A token whose message is blank redirects, renders an empty strip, and
    // says exactly as much as no strip at all.
    for (const [key, message] of Object.entries(SAVED_MESSAGES)) {
      expect(message.length, `${key} says nothing`).toBeGreaterThan(3);
      expect(message.trim(), `${key} is not trimmed`).toBe(message);
      expect(message, `${key} is not a sentence`).toMatch(/[.!?]$/);
    }
    expect(Object.keys(SAVED_MESSAGES).length).toBeGreaterThan(3);
  });
});
