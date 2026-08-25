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
import { issueDisplayToken } from '../src/auth/tokens.js';

/**
 * The template gallery routes (RFC 005): browse, apply, copy.
 *
 * The tests that matter drive the real app the way a household does — a real
 * session cookie, a real form POST — because the value is end to end: applying a
 * template lands a canvas that the manifest a screen polls actually carries, and
 * the gate refuses an unauthenticated apply before it can write anything.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let n = 0;
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A signed-in harness: build the app, run the wizard, hold the session cookie. */
async function ready() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-tplroutes-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(
    /*
     * With a location. These tests place Weather widgets and assert what
     * reaches the manifest, and a widget the household has nothing set up for
     * is omitted on the way out (RFC 009 Phase 2) — so a bare household would
     * make every one of those assertions about a box that is not there rather
     * than about the config it carries.
     */
    `INSERT INTO household_settings (id, latitude, longitude, created_at, updated_at)
     VALUES ('singleton', 51.5, -0.12, ?, ?)`,
  ).run(stamp, stamp);

  const address = `10.9.1.${++n}`;
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 't'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => address,
    setupToken,
    dataDir,
  });

  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie !== '') headers.set('cookie', cookie);
    const res = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers, redirect: 'manual' }));
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return res;
  };
  const postForm = (path: string, fields: Record<string, string>) =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  await call(`/setup?token=${setupToken.current().token}`);
  await postForm('/setup/account', {
    name: 'H', email: `t${n}@home.local`,
    password: 'correct-horse-battery', confirm: 'correct-horse-battery',
  });
  await postForm('/setup/household', { timezone: 'Europe/London' });

  const manifestLayout = async () => {
    const issued = issueDisplayToken();
    const at = Date.now();
    db.prepare(
      `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
       VALUES ('s1','Wall',?,?,?,?) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash`,
    ).run(issued.tokenHash, at, at, at);
    const res = await call('/d/manifest', { headers: { authorization: `Bearer ${issued.token}` } });
    const body = (await res.json()) as {
      layout: { mode: string; portrait: { widgets: { type: string; config?: unknown }[] } };
    };
    return body.layout;
  };

  const applyBare = (path: string, fields: Record<string, string>) =>
    app.fetch(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
        redirect: 'manual',
      }),
    );

  return { db, call, postForm, manifestLayout, applyBare };
}

describe('the template gallery routes', () => {
  it('shows the gallery, behind the session, listing the shipped templates', async () => {
    const h = await ready();
    const res = await h.call('/admin/displays/default/gallery');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Sky Calendar');
    expect(html).toContain('Meeting Room');
    expect(html).toContain('assets/template-gallery.js');
  });

  it('applies a template and lands its canvas in the manifest a screen polls', async () => {
    const h = await ready();
    const res = await h.postForm('/admin/displays/default/apply-template', { templateId: 'sky-calendar' });
    expect(res.status).toBe(302);

    const layout = await h.manifestLayout();
    expect(layout.mode).toBe('freeform');
    // Sky Calendar: clock, weather, then a month calendar with pills.
    expect(layout.portrait.widgets.map((w) => w.type)).toEqual(['clock', 'weather', 'calendar']);
    const cal = layout.portrait.widgets.find((w) => w.type === 'calendar');
    expect(cal?.config).toEqual({ cellEvents: 'pills' });
  });

  it('refuses an unknown template with a 400 and writes nothing', async () => {
    const h = await ready();
    const res = await h.postForm('/admin/displays/default/apply-template', { templateId: 'nope' });
    expect(res.status).toBe(400);
    expect((h.db.prepare('SELECT count(*) c FROM layout_widgets').get() as { c: number }).c).toBe(0);
  });

  it('copies one display layout onto another', async () => {
    const h = await ready();
    const at = Date.now();
    h.db
      .prepare(
        `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
         VALUES ('wallK','Kitchen','h',?,?,?)`,
      )
      .run(at, at, at);
    await h.postForm('/admin/displays/default/apply-template', { templateId: 'family-hub' });
    const res = await h.postForm('/admin/displays/wallK/copy-from', { sourceOwner: 'default' });
    expect(res.status).toBe(302);

    const kitchen = h.db
      .prepare(`SELECT count(*) c FROM layout_widgets WHERE screen_id = 'wallK' AND orientation='portrait'`)
      .get() as { c: number };
    expect(kitchen.c).toBeGreaterThan(0);
    const mode = (h.db.prepare(`SELECT layout_mode AS m FROM screens WHERE id='wallK'`).get() as { m: string }).m;
    expect(mode).toBe('freeform');
  });

  it('resets a display to the Classic layout (auto was retired)', async () => {
    const h = await ready();
    await h.postForm('/admin/displays/default/apply-template', { templateId: 'sky-week' });
    const before = h.db
      .prepare(`SELECT count(*) c FROM layout_widgets WHERE orientation = 'portrait'`)
      .get() as { c: number };
    expect(before.c).toBeGreaterThan(0);

    const res = await h.postForm('/admin/displays/default/reset-layout', {});
    expect(res.status).toBe(302);
    // Reset re-applies Classic, so both canvases carry its widgets — there is no
    // empty "auto" state to fall back to any more.
    const types = h.db
      .prepare(`SELECT type FROM layout_widgets WHERE orientation = 'portrait' ORDER BY z`)
      .all() as { type: string }[];
    expect(types.map((t) => t.type)).toContain('calendar');
    expect(types.length).toBeGreaterThan(0);
    const mode = (h.db.prepare(`SELECT layout_mode AS m FROM household_settings`).get() as { m: string }).m;
    expect(mode).toBe('freeform');
  });

  it('is behind the session gate — an unauthenticated apply writes nothing', async () => {
    const h = await ready();
    const res = await h.applyBare('/admin/displays/default/apply-template', { templateId: 'sky-calendar' });
    expect([302, 401]).toContain(res.status);
    expect((h.db.prepare('SELECT count(*) c FROM layout_widgets').get() as { c: number }).c).toBe(0);
  });
});
