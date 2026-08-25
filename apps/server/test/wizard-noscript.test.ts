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
 * The wizard and sign-in are deliberately plain server-rendered HTML with no
 * script, because they are the screens that must work before anything else
 * does. This pins that property against drift: the ONLY script either page
 * may serve is the shared inline theme script the head applies before first
 * paint — today's baseline — and nothing here may ever load one by src.
 *
 * A restyle that quietly grew a script would pass every visual check; this is
 * the test that refuses it.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-noscript-'));
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
    auth: { secret: 'n'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => '10.7.7.1',
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

function scriptsOf(html: string): string[] {
  const out: string[] = [];
  const pattern = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
  for (let m = pattern.exec(html); m !== null; m = pattern.exec(html)) out.push(m[0]);
  return out;
}

/** Exactly the baseline: one inline theme script, nothing loaded by src. */
function expectOnlyThemeScript(html: string, page: string): void {
  const scripts = scriptsOf(html);
  expect(scripts.length, `${page} must serve exactly the inline theme script`).toBe(1);
  const only = scripts[0] as string;
  expect(/\bsrc\s*=/i.test(only), `${page} must not load a script by src`).toBe(false);
  expect(only, `${page}'s one script must be the theme script`).toContain('mw-admin-theme');
}

describe('the wizard and sign-in stay script-free', () => {
  it('serves exactly the inline theme script on every step and on sign-in', async () => {
    const h = await harness();

    // The code-entry form, before anything exists.
    const codeForm = await h.call('/setup');
    expect(codeForm.status).toBe(200);
    expectOnlyThemeScript(await codeForm.text(), '/setup (code form)');

    // The account form, through the token exchange.
    await h.call(`/setup?token=${h.setupToken.current().token}`);
    const accountForm = await h.call('/setup');
    expect(accountForm.status).toBe(200);
    expectOnlyThemeScript(await accountForm.text(), '/setup (account form)');

    await h.form('/setup/account', {
      name: 'Household', email: 'family@home.local',
      password: 'correct-horse-battery', confirm: 'correct-horse-battery',
    });

    // The timezone step, then the optional calendar step.
    const timezone = await h.call('/setup');
    expect(timezone.status).toBe(200);
    expectOnlyThemeScript(await timezone.text(), '/setup (timezone form)');

    await h.form('/setup/household', { timezone: 'Europe/London' });
    const calendar = await h.call('/setup/calendar');
    expect(calendar.status).toBe(200);
    expectOnlyThemeScript(await calendar.text(), '/setup/calendar');

    // And step 4, which asks for a location and a first person. Two coordinate
    // fields is exactly the shape somebody reaches for a map picker to fill in,
    // so this is the step most likely to grow a script.
    const place = await h.call('/setup/place');
    expect(place.status).toBe(200);
    expectOnlyThemeScript(await place.text(), '/setup/place');

    // Sign-in, signed out — served before any credential exists.
    h.jar.clear();
    const signIn = await h.call('/admin/sign-in');
    expect(signIn.status).toBe(200);
    expectOnlyThemeScript(await signIn.text(), '/admin/sign-in');
  });
});
