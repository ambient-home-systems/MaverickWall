import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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
import { issueDisplayToken } from '../src/auth/tokens.js';
import { contentEtag } from '../src/http/static.js';
import { versionedShell } from '../src/http/shell-version.js';

/**
 * Which release is talking (plan item M1.5): stamped into the wall's page as
 * it is served, and sent on every `/d/manifest` answer — refusals and 304s
 * included — so a wall can tell its own code is older than the server's.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const SHELL = '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n  </head>\n  <body></body>\n</html>\n';

function appAt(version: string, shared?: { dataDir: string; db: SqliteDatabase; displayDir: string }) {
  const dataDir = shared?.dataDir ?? mkdtempSync(join(tmpdir(), 'mw-release-'));
  if (shared === undefined) roots.push(dataDir);
  const db = shared?.db ?? openDatabase({ dataDir }).db;
  if (shared === undefined) {
    runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
    const stamp = Date.now();
    // A household that has finished setup: the gate sends anybody else's `/` to the wizard.
    db.prepare(
      `INSERT INTO household_settings (id, setup_completed_at, created_at, updated_at) VALUES ('singleton', ?, ?, ?)`,
    ).run(stamp, stamp, stamp);
  }
  const displayDir = shared?.displayDir ?? join(dataDir, 'display');
  if (shared === undefined) {
    mkdirSync(displayDir, { recursive: true });
    writeFileSync(join(displayDir, 'index.html'), SHELL);
  }
  const app = createApp({
    db,
    appVersion: version,
    bootNotices: [],
    auth: { secret: 'r'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => '10.20.0.1',
    setupToken: createSetupTokenHolder(() => {}),
    dataDir,
    displayDir,
  });
  return { app, db, dataDir, displayDir };
}

describe('the wall’s page', () => {
  it('carries the release that served it, in its head', async () => {
    const { app } = appAt('0.80.0');
    const page = await (await app.fetch(new Request('http://localhost/'))).text();
    expect(page).toContain('<head>\n    <meta name="mw-version" content="0.80.0" />');
  });

  it('is a different page to every cache once the release changes, and the same page until then', async () => {
    const first = appAt('0.80.0');
    const old = await first.app.fetch(new Request('http://localhost/'));
    const etag = old.headers.get('etag')!;
    expect((await first.app.fetch(new Request('http://localhost/', { headers: { 'if-none-match': etag } }))).status).toBe(304);
    const updated = appAt('0.81.0', first);
    const after = await updated.app.fetch(new Request('http://localhost/', { headers: { 'if-none-match': etag } }));
    expect(after.status).toBe(200);
    expect(await after.text()).toContain('content="0.81.0"');
  });
});

describe('versionedShell', () => {
  const file = { body: Buffer.from(SHELL), contentType: 'text/html', etag: '"x"', gzip: Buffer.from('stale') };

  it('takes an ETag from its own bytes and drops a gzip of the unstamped ones', () => {
    const stamped = versionedShell(file, '1.2.3');
    expect(stamped.etag).toBe(contentEtag(stamped.body));
    expect(stamped.gzip).toBeUndefined();
  });

  it('escapes the version, and stamps a page with no head at all', () => {
    expect(versionedShell(file, '"><script>').body.toString()).toContain('content="&quot;&gt;&lt;script&gt;"');
    const headless = versionedShell({ ...file, body: Buffer.from('<p>hi</p>') }, '1.2.3');
    expect(headless.body.toString().startsWith('<meta name="mw-version" content="1.2.3" />')).toBe(true);
  });
});

describe('every /d/manifest answer', () => {
  it('says which release is answering: a body, a 304, and a refusal', async () => {
    const { app, db } = appAt('0.80.0');
    const issued = issueDisplayToken();
    const stamp = Date.now();
    db.prepare(
      `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, created_at, updated_at)
       VALUES ('wall', 'Wall', ?, 'panels', ?, ?, ?)`,
    ).run(issued.tokenHash, stamp, stamp, stamp);
    const ask = (headers: Record<string, string>) =>
      app.fetch(new Request('http://localhost/d/manifest', { headers }));

    const fresh = await ask({ authorization: `Bearer ${issued.token}` });
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get('x-app-version')).toBe('0.80.0');
    const unchanged = await ask({ authorization: `Bearer ${issued.token}`, 'if-none-match': fresh.headers.get('etag')! });
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get('x-app-version')).toBe('0.80.0');
    const refused = await ask({ authorization: 'Bearer nobody' });
    expect(refused.status).toBe(401);
    expect(refused.headers.get('x-app-version')).toBe('0.80.0');
  });
});
