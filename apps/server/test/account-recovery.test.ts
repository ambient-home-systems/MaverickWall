import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { countUsers, readSetupState } from '../src/api/queries.js';
import type { SetupToken } from '../src/auth/tokens.js';

/**
 * The manual account-recovery procedure documented in
 * `docs/troubleshooting.md` — "I forgot the account password" — proven
 * against the real schema rather than asserted in prose.
 *
 * `DELETE FROM user` plus clearing `setup_completed_at` is a household
 * running raw SQL against their own database with the container stopped, so
 * there is no handler to call here. What this proves is the two facts the
 * documentation depends on: the cascade from `user` reaches only `account`
 * and `session` (so calendars and screens survive), and the app treats the
 * result exactly like a fresh install rather than the stuck `/setup/done`
 * a completed household with no user would otherwise hit.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-recovery-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const issued: SetupToken[] = [];
  const setupToken = createSetupTokenHolder((token) => issued.push(token));

  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'r'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
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

  return { db, call, form, setupToken };
}

/** A calendar and a paired screen, so the test has real rows to prove survive. */
function seedHouseholdData(db: SqliteDatabase): void {
  const stamp = Date.now();
  db.prepare(
    `INSERT INTO calendar_sources
       (id, name, url_encrypted, url_host, color, enabled, visible, created_at, updated_at)
     VALUES ('cal1', 'Family', 'ciphertext', 'example.com', '#4C7FD1', 1, 1, ?, ?)`,
  ).run(stamp, stamp);
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
     VALUES ('screen1', 'Kitchen', 'hash', ?, ?, ?)`,
  ).run(stamp, stamp, stamp);
}

describe('recovering a forgotten password by deleting the account', () => {
  it('cascades from user to account and session only, leaving the household data untouched', async () => {
    const { db, call, form, setupToken } = harness();
    await call(`/setup?token=${setupToken.current().token}`);
    await form('/setup/account', {
      name: 'Household',
      email: 'family@home.local',
      password: 'correct-horse-battery',
      confirm: 'correct-horse-battery',
    });
    seedHouseholdData(db);
    expect(countUsers(db)).toBe(1);
    const accountsBefore = (db.prepare('SELECT COUNT(*) AS n FROM account').get() as { n: number }).n;
    expect(accountsBefore).toBeGreaterThan(0);

    // The documented recovery: run with the container stopped.
    db.prepare('DELETE FROM user').run();
    db.prepare(`UPDATE household_settings SET setup_completed_at = NULL WHERE id = 'singleton'`).run();

    expect(countUsers(db)).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM account').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM session').get() as { n: number }).n).toBe(0);

    // Nothing else moved.
    expect((db.prepare('SELECT COUNT(*) AS n FROM calendar_sources').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM screens').get() as { n: number }).n).toBe(1);
    const source = db.prepare('SELECT name FROM calendar_sources WHERE id = ?').get('cal1') as {
      name: string;
    };
    expect(source.name).toBe('Family');
  });

  it('reprints a setup code on the next boot and opens account creation, not the stuck "done" page', async () => {
    const { db, call, form, setupToken } = harness();
    await call(`/setup?token=${setupToken.current().token}`);
    await form('/setup/account', {
      name: 'Household',
      email: 'family@home.local',
      password: 'correct-horse-battery',
      confirm: 'correct-horse-battery',
    });
    await form('/setup/household', { timezone: 'Europe/London' });
    expect(readSetupState(db).complete).toBe(true);

    db.prepare('DELETE FROM user').run();
    db.prepare(`UPDATE household_settings SET setup_completed_at = NULL WHERE id = 'singleton'`).run();

    // What main.ts does at boot: reissue the code only when there is nobody.
    if (countUsers(db) === 0) setupToken.current();

    const response = await call('/setup');
    expect(response.status).toBe(200);
    const body = await response.text();
    // Not the dead end a completed household with no user would hit: with
    // setup_completed_at still set, this would redirect to /setup/done and
    // offer no way to create a new account at all.
    expect(body).toContain('Enter the setup code');

    // And the reissued code genuinely creates a fresh account.
    const token = setupToken.current();
    await call(`/setup?token=${token.token}`);
    const created = await form('/setup/account', {
      name: 'Household',
      email: 'new@home.local',
      password: 'a-new-password-entirely',
      confirm: 'a-new-password-entirely',
    });
    expect(created.status).toBe(302);
    expect(countUsers(db)).toBe(1);
  });
});
